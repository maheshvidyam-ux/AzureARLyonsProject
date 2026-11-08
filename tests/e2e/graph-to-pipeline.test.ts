/**
 * Phase 2 — Graph ingestion wired to the pipeline (spec §4 exit criterion): a mailbox sweep
 * via the real `GraphMailboxSource` (over the fake low-level client) flows straight into the
 * existing pipeline and persists normalized orders — no fake mailbox, no live inbox.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { GraphMailboxSource, InMemoryDeltaStore } from "../../apps/workers/src/ingestion/graph/index.js";
import { FakeGraphApiClient } from "../../mocks/graph/fake-graph-api.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { runSlice, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";

function makeDeps(): PipelineDeps & { persistence: InMemoryPersistence } {
  return {
    blob: new InMemoryBlobStore(),
    persistence: new InMemoryPersistence(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
  };
}

describe("Graph → pipeline", () => {
  it("a mailbox sweep becomes normalized, persisted orders (and stops before staging)", async () => {
    const source = new GraphMailboxSource({ client: new FakeGraphApiClient(), mailbox: "orders@lyons.example.com", deltaStore: new InMemoryDeltaStore() });
    const deps = makeDeps();

    const messages = await source.fetchMessages();
    expect(messages).toHaveLength(2);

    const results = await runSlice(deps, messages);
    expect(results.map((r) => r.decision)).toEqual(["READY", "NEEDS_REVIEW"]);
    for (const r of results) expect(r.stagedBlocked).toBe(true);
    expect(await deps.persistence.countOrders()).toBe(2);
  });

  it("re-processing the same swept messages is idempotent (no duplicate orders)", async () => {
    const source = new GraphMailboxSource({ client: new FakeGraphApiClient(), mailbox: "orders@lyons.example.com", deltaStore: new InMemoryDeltaStore() });
    const deps = makeDeps();

    const messages = await source.fetchMessages();
    const first = await runSlice(deps, messages);
    const second = await runSlice(deps, messages);

    expect(await deps.persistence.countOrders()).toBe(2);
    expect(second[0]!.orderHeaderId).toBe(first[0]!.orderHeaderId);
  });

  it("delta cursor advances: a second sweep returns no new messages", async () => {
    const source = new GraphMailboxSource({ client: new FakeGraphApiClient(), mailbox: "orders@lyons.example.com", deltaStore: new InMemoryDeltaStore() });

    expect(await source.fetchMessages()).toHaveLength(2);
    expect(await source.fetchMessages()).toHaveLength(0);
  });
});
