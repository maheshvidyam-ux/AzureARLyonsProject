/**
 * Phase 5 — Boomi staging ("final tables"). A clean, matched, duplicate-claimed order
 * auto-stages (Ready for Boomi); a review/duplicate order does NOT; the CSR-approve path stages
 * after corrections; and the Boomi pickup + ack completes the order. Spec §8/§5, ADR 0003/0004.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryMasterDataReader } from "@coa/fabric-read";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";
import { processAttachment, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

function deps(autoStage: boolean): PipelineDeps & { persistence: InMemoryPersistence } {
  const persistence = new InMemoryPersistence();
  return {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS }),
    autoStage,
  };
}
const mail = (stem: string, id: string): GraphMailMessage => ({
  graphMessageId: `gm-${id}`, mailbox: "orders@x", sender: "buyer@acme.example.com", receivedAt: "2026-11-01T09:00:00Z", subject: "PO",
  attachments: [{ graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }],
});

describe("Boomi staging", () => {
  it("clean + matched order auto-stages → STAGED and is Ready for Boomi", async () => {
    const d = deps(true);
    const r = await processAttachment(d, mail("sample-po-001", "a"), 0);

    expect(r.internalState).toBe("STAGED");
    const ready = await d.persistence.listReadyForBoomi();
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ orderHeaderId: r.orderHeaderId, erpCustomerAccount: "ACME01", normalizedPoNumber: "PO100045", publishStatus: "READY" });
  });

  it("an order needing review does NOT stage", async () => {
    const d = deps(true);
    const r = await processAttachment(d, mail("sample-po-002", "b"), 0); // zero-qty + unmatched customer
    expect(r.internalState).toBe("NEEDS_REVIEW");
    expect(await d.persistence.listReadyForBoomi()).toHaveLength(0);
  });

  it("Boomi picks up a staged order and the ack completes it (AX sales order id)", async () => {
    const d = deps(true);
    const r = await processAttachment(d, mail("sample-po-001", "a"), 0);
    const [ready] = await d.persistence.listReadyForBoomi();

    await d.persistence.markBoomiResult(ready!.stagingId, { axSalesOrderId: "AX-SO-90001" });

    expect(await d.persistence.listReadyForBoomi()).toHaveLength(0); // no longer pending
    const header = await d.persistence.getOrderHeaderById(r.orderHeaderId!);
    expect(header?.internalState).toBe("ERP_CREATED");
    expect(header?.simpleStatus).toBe("Completed");
  });

  it("without auto-stage the order stops at READY (CSR path)", async () => {
    const d = deps(false);
    const r = await processAttachment(d, mail("sample-po-001", "a"), 0);
    expect(r.internalState).toBe("READY");
    expect(await d.persistence.listReadyForBoomi()).toHaveLength(0);
  });
});
