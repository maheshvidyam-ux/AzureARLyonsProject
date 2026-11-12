/**
 * AP_INVOICE persistence + Boomi staging (ADR 0008 / migration 0004). A clean, matched,
 * non-duplicate PO invoice is persisted and auto-staged to staging_vendor_invoice (Ready for
 * Boomi); Non-PO / review invoices persist but do NOT stage; Boomi pickup + ack completes the
 * invoice with an AX voucher id; dedup is enforced via the shared atomic claim.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryInvoiceMasterReader } from "@coa/fabric-read";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_VENDORS, SAMPLE_PO_LINES, SAMPLE_RECEIPTS } from "../../mocks/fabric/sample-invoice-masters.js";
import { PersistenceInvoiceDedup, processInvoice, type InvoicePipelineDeps } from "../../apps/workers/src/invoice/index.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

function deps(persistence: InMemoryPersistence, autoStage = true): InvoicePipelineDeps {
  return {
    blob: new InMemoryBlobStore(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryInvoiceMasterReader({ vendors: SAMPLE_VENDORS, poLines: SAMPLE_PO_LINES, receipts: SAMPLE_RECEIPTS }),
    dedup: new PersistenceInvoiceDedup(persistence),
    persistence,
    autoStage,
  };
}
const mail = (stem: string, id: string): GraphMailMessage => ({
  graphMessageId: `gm-${id}`, mailbox: "ap-invoices@lyons.example.com", sender: "ap@acme.example.com", receivedAt: "2026-11-02T09:00:00Z", subject: "Invoice",
  attachments: [{ graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }],
});

describe("AP invoice persistence + staging", () => {
  it("clean PO invoice → persisted + auto-staged (Ready for Boomi)", async () => {
    const p = new InMemoryPersistence();
    const r = await processInvoice(deps(p), mail("sample-inv-po-001", "a"), 0);

    expect(r.internalState).toBe("STAGED");
    expect(r.stagedBlocked).toBe(false);
    expect(r.invoiceHeaderId).not.toBeNull();

    const ready = await p.listVendorInvoicesForBoomi();
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ invoiceHeaderId: r.invoiceHeaderId, erpVendorAccount: "VEND-ACME", invoiceType: "PO_BASED", normalizedInvoiceNumber: "INV5001", publishStatus: "READY" });
  });

  it("Non-PO invoice persists but does NOT stage (awaits Code & Approve)", async () => {
    const p = new InMemoryPersistence();
    const r = await processInvoice(deps(p), mail("sample-inv-nonpo-001", "b"), 0);
    expect(r.internalState).toBe("NEEDS_REVIEW");
    expect(r.invoiceHeaderId).not.toBeNull();
    expect(await p.listVendorInvoicesForBoomi()).toHaveLength(0);
  });

  it("Boomi picks up the staged invoice and the ack completes it (AX voucher id)", async () => {
    const p = new InMemoryPersistence();
    await processInvoice(deps(p), mail("sample-inv-po-001", "a"), 0);
    const [ready] = await p.listVendorInvoicesForBoomi();

    await p.markVendorInvoiceResult(ready!.stagingId, { axVoucherId: "AX-VCH-70001" });
    expect(await p.listVendorInvoicesForBoomi()).toHaveLength(0);
  });

  it("duplicate invoice is blocked (shared atomic claim) → DUPLICATE_REVIEW, not staged", async () => {
    const p = new InMemoryPersistence();
    const first = await processInvoice(deps(p), mail("sample-inv-po-001", "a"), 0);
    const second = await processInvoice(deps(p), mail("sample-inv-po-001", "b"), 0);

    expect(first.internalState).toBe("STAGED");
    expect(second.internalState).toBe("DUPLICATE_REVIEW");
    expect((await p.listVendorInvoicesForBoomi()).length).toBe(1); // only the first
  });
});
