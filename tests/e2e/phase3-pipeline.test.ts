/**
 * Phase 3 — matching + duplicate claim wired into the pipeline (spec §6, §8). Exit criteria:
 * a matched clean PO claims its key and reaches READY; a second PO with the same key is blocked
 * into DUPLICATE_REVIEW; an email/EDI cross-channel collision is blocked; an unmatched customer
 * and stale masters degrade to controlled review — never staged.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryMasterDataReader } from "@coa/fabric-read";
import { duplicateBusinessKey } from "@coa/domain";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";
import { processAttachment, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

function deps(opts: { stale?: boolean } = {}): PipelineDeps & { persistence: InMemoryPersistence } {
  const persistence = new InMemoryPersistence();
  return {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS, stale: opts.stale }),
  };
}

/** Build a mail message for a fixture stem with distinct Graph ids (so it's a separate order). */
function mail(stem: string, id: string): GraphMailMessage {
  return {
    graphMessageId: `gm-${id}`,
    mailbox: "orders@lyons.example.com",
    sender: "buyer@acme.example.com",
    receivedAt: "2026-11-01T09:00:00Z",
    subject: "Purchase Order",
    attachments: [{ graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(`pdf ${id}`).toString("base64") }],
  };
}

describe("Phase 3 — matching + duplicate claim in the pipeline", () => {
  it("clean matched PO → customer+items matched, key claimed, READY", async () => {
    const d = deps();
    const r = await processAttachment(d, mail("sample-po-001", "a"), 0);

    expect(r.decision).toBe("READY");
    expect(r.internalState).toBe("READY");
    expect(r.normalized!.header.customer!.match_status).toBe("EXACT");
    expect(r.normalized!.header.customer!.erp_customer_account!.value).toBe("ACME01");
    expect(r.normalized!.lines[0]!.match_status).toBe("EXACT_SKU");
    expect(r.normalized!.lines[0]!.erp_item_id!.value).toBe("ITM-778");
    expect(r.duplicateBusinessKey).toBe("USMF::ACME01::PO100045");
    expect(r.findings.some((f) => f.blocking)).toBe(false);
    expect(r.stagedBlocked).toBe(true);
  });

  it("second PO with the same business key → DUPLICATE_REVIEW (exactly one claim wins)", async () => {
    const d = deps();
    const first = await processAttachment(d, mail("sample-po-001", "a"), 0);
    const second = await processAttachment(d, mail("sample-po-001", "b"), 0);

    expect(first.internalState).toBe("READY");
    expect(second.internalState).toBe("DUPLICATE_REVIEW");
    expect(second.findings.some((f) => f.code === "DUPLICATE_DETECTED" && f.blocking)).toBe(true);
    expect(await d.persistence.countOrders()).toBe(2); // both orders exist; only one staged-eligible
  });

  it("cross-channel: a pre-registered EDI order blocks the Email PO", async () => {
    const d = deps();
    const key = duplicateBusinessKey({ normalizedPoNumber: "PO100045", erpCustomerAccount: "ACME01", companyId: "USMF" })!;
    await d.persistence.seedExternalClaim({ companyId: "USMF", businessKey: key, channel: "EDI", matchedExistingRef: "EDI-850-42" });

    const r = await processAttachment(d, mail("sample-po-001", "a"), 0);
    expect(r.internalState).toBe("DUPLICATE_REVIEW");
    expect(r.trace.join(" ")).toMatch(/DUPLICATE collision vs EDI/);
  });

  it("unmatched customer → CUSTOMER_UNMATCHED blocking, NEEDS_REVIEW, no claim", async () => {
    const d = deps();
    // sample-po-002's customer is "Unknown Buyer" (not in masters) and it also has a zero-qty line.
    const r = await processAttachment(d, mail("sample-po-002", "c"), 0);
    expect(r.internalState).toBe("NEEDS_REVIEW");
    expect(r.findings.some((f) => f.code === "CUSTOMER_UNMATCHED" && f.blocking)).toBe(true);
  });

  it("stale master data → MASTER_DATA_STALE controlled exception, NEEDS_REVIEW, no claim", async () => {
    const d = deps({ stale: true });
    const r = await processAttachment(d, mail("sample-po-001", "a"), 0);
    expect(r.internalState).toBe("NEEDS_REVIEW");
    expect(r.findings.some((f) => f.code === "MASTER_DATA_STALE" && f.blocking)).toBe(true);
  });
});
