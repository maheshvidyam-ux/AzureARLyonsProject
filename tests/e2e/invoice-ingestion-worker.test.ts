/**
 * AP invoice ingestion worker — the AP-mailbox loop: queue message id → Graph fetch → invoice
 * pipeline → persisted vendor invoice. In-memory queue + persistence + a fake AP Graph client; no
 * Service Bus, no live mailbox.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryIngestionQueue } from "@coa/messaging";
import { InMemoryInvoiceMasterReader } from "@coa/fabric-read";
import { InvoiceIngestionWorker } from "../../apps/workers/src/ingestion/invoice-ingestion-worker.js";
import { PersistenceInvoiceDedup, type InvoicePipelineDeps } from "../../apps/workers/src/invoice/index.js";
import { FakeInvoiceGraphApiClient } from "../../mocks/graph/fake-invoice-graph-api.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_VENDORS, SAMPLE_PO_LINES, SAMPLE_RECEIPTS } from "../../mocks/fabric/sample-invoice-masters.js";

const MAILBOX = "ap-invoices@lyons.example.com";

function makeWorker() {
  const persistence = new InMemoryPersistence();
  const pipeline: InvoicePipelineDeps = {
    blob: new InMemoryBlobStore(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryInvoiceMasterReader({ vendors: SAMPLE_VENDORS, poLines: SAMPLE_PO_LINES, receipts: SAMPLE_RECEIPTS }),
    dedup: new PersistenceInvoiceDedup(persistence),
    persistence,
    autoStage: true,
  };
  const worker = new InvoiceIngestionWorker({ client: new FakeInvoiceGraphApiClient(), mailbox: MAILBOX, pipeline });
  return { worker, persistence };
}

describe("InvoiceIngestionWorker", () => {
  it("drains queued AP message ids into persisted invoices", async () => {
    const { worker, persistence } = makeWorker();
    const queue = new InMemoryIngestionQueue();
    await queue.publish({ messageId: "inv-001" }); // PO-based → READY → auto-staged
    await queue.publish({ messageId: "inv-002" }); // Non-PO → NEEDS_REVIEW (C&A)

    const outcomes = await worker.drain(queue);

    expect(outcomes.map((o) => o.messageId)).toEqual(["inv-001", "inv-002"]);
    expect(outcomes.every((o) => !o.error)).toBe(true);
    expect(await persistence.listInvoices({})).toHaveLength(2);

    const states = (await persistence.listInvoices({})).map((i) => i.internalState).sort();
    expect(states).toContain("NEEDS_REVIEW"); // the Non-PO C&A invoice
    expect(states).toContain("STAGED"); // the clean PO-based invoice auto-staged
  });

  it("captures a Graph fetch error on the message outcome without aborting the batch", async () => {
    const { worker } = makeWorker();
    const outcome = await worker.handleMessageId("does-not-exist");
    expect(outcome.error).toMatch(/404/);
    expect(outcome.results).toHaveLength(0);
  });
});
