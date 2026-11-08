/**
 * §16 critical-case coverage for the first vertical slice (backlog §9.3 / §9.4).
 * Exercises the clean single PO, a blocking-validation PO (review branch), the
 * "AI malformed JSON" degradation, and ingestion/persistence idempotency on replay.
 * Everything runs on quarantined mocks + the in-memory persistence, and asserts the
 * order graph is persisted and nothing is ever staged.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { validateNormalizedPo } from "@coa/po-schema";
import { FakeGraphSource, type SampleStem } from "../../mocks/graph/fake-mailbox.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { processAttachment, runSlice, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";

function makeDeps(): PipelineDeps & { persistence: InMemoryPersistence } {
  const persistence = new InMemoryPersistence();
  return {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
  };
}

async function runOne(stem: SampleStem, deps = makeDeps()) {
  const [message] = await new FakeGraphSource([stem]).fetchMessages();
  const result = await processAttachment(deps, message!, 0);
  return { result, deps };
}

describe("first slice — ingest one PO end-to-no-stage (persisted)", () => {
  it("clean single PO → READY, schema-valid, order persisted, stops before staging", async () => {
    const { result: r, deps } = await runOne("sample-po-001");

    expect(r.decision).toBe("READY");
    expect(r.internalState).toBe("READY");
    expect(r.stagedBlocked).toBe(true);

    expect(validateNormalizedPo(r.normalized).valid).toBe(true);
    expect(r.normalized!.header.normalized_po_number).toBe("PO100045");
    expect(r.normalized!.lines).toHaveLength(2);
    expect(r.findings.some((f) => f.blocking)).toBe(false);

    // Persisted and readable back.
    expect(r.orderHeaderId).not.toBeNull();
    const header = await deps.persistence.getOrderHeaderById(r.orderHeaderId!);
    expect(header?.internalState).toBe("READY");
    expect(header?.normalizedPoNumber).toBe("PO100045");
    expect(header?.lineCount).toBe(2);
    expect(await deps.persistence.countOrders()).toBe(1);
  });

  it("PO with zero-quantity line → NEEDS_REVIEW, blocking finding persisted, never staged", async () => {
    const { result: r, deps } = await runOne("sample-po-002");

    expect(r.decision).toBe("NEEDS_REVIEW");
    expect(r.stagedBlocked).toBe(true);

    const persistedFindings = await deps.persistence.getValidationByOrderId(r.orderHeaderId!);
    const qty = persistedFindings.find((f) => f.code === "LINE_QUANTITY_INVALID");
    expect(qty?.blocking).toBe(true);
    expect(persistedFindings.some((f) => f.code === "REQUIRED_PO_DATE_MISSING" && !f.blocking)).toBe(true);
  });

  it("AI returns malformed JSON → controlled FAILED, no order persisted, mail marked FAILED", async () => {
    const { result: r, deps } = await runOne("sample-po-003");

    expect(r.decision).toBe("FAILED");
    expect(r.orderHeaderId).toBeNull();
    expect(r.normalized).toBeNull();
    expect(r.stagedBlocked).toBe(true);
    expect(r.findings.some((f) => f.code === "FOUNDRY_OUTPUT_UNPARSEABLE" && f.blocking)).toBe(true);

    expect(await deps.persistence.countOrders()).toBe(0);
    const mail = await deps.persistence.getMailMessageById(r.ingestion.mailMessageId);
    expect(mail?.processingOutcome).toBe("FAILED");
  });

  it("replayed message → idempotent: one order, one blob write, one ingestion record", async () => {
    const deps = makeDeps();
    const [message] = await new FakeGraphSource(["sample-po-001"]).fetchMessages();

    const first = await processAttachment(deps, message!, 0);
    const second = await processAttachment(deps, message!, 0);

    expect(first.ingestion.created).toBe(true);
    expect(second.ingestion.created).toBe(false);
    expect(first.orderHeaderId).toBe(second.orderHeaderId); // same order, no duplicate
    expect(await deps.persistence.countOrders()).toBe(1);
    expect(deps.blob.writeCount()).toBe(1);
    expect(second.decision).toBe("READY");
  });

  it("whole sample set runs, persists, and never advances past a pre-staging state", async () => {
    const deps = makeDeps();
    const messages = await new FakeGraphSource().fetchMessages();
    const results = await runSlice(deps, messages);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.stagedBlocked).toBe(true);
      expect(["READY", "NEEDS_REVIEW", "FAILED"]).toContain(r.internalState);
    }
    expect(results.map((r) => r.decision)).toEqual(["READY", "NEEDS_REVIEW", "FAILED"]);
    // Two normalized orders persisted (001, 002); 003 failed before an order existed.
    expect(await deps.persistence.countOrders()).toBe(2);
  });
});
