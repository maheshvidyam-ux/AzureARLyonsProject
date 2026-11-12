/**
 * AP_INVOICE module — invoice pipeline (ADR 0008). PO-based 3-way match → READY; Non-PO →
 * Code & Approve review; over-receipt → review; duplicate invoice → DUPLICATE_REVIEW; vendor
 * unmatched → review; malformed AI → controlled FAILED. All on quarantined mocks.
 */
import { describe, expect, it } from "vitest";
import { InMemoryInvoiceMasterReader, type GoodsReceipt } from "@coa/fabric-read";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_VENDORS, SAMPLE_PO_LINES, SAMPLE_RECEIPTS } from "../../mocks/fabric/sample-invoice-masters.js";
import { InMemoryInvoiceDedup, processInvoice, type InvoicePipelineDeps } from "../../apps/workers/src/invoice/index.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

function deps(over?: { receipts?: GoodsReceipt[]; vendors?: typeof SAMPLE_VENDORS; dedup?: InMemoryInvoiceDedup }): InvoicePipelineDeps {
  return {
    blob: new InMemoryBlobStore(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryInvoiceMasterReader({ vendors: over?.vendors ?? SAMPLE_VENDORS, poLines: SAMPLE_PO_LINES, receipts: over?.receipts ?? SAMPLE_RECEIPTS }),
    dedup: over?.dedup ?? new InMemoryInvoiceDedup(),
  };
}
const mail = (stem: string, id: string): GraphMailMessage => ({
  graphMessageId: `gm-${id}`, mailbox: "ap-invoices@lyons.example.com", sender: "ap@acme.example.com", receivedAt: "2026-11-02T09:00:00Z", subject: "Invoice",
  attachments: [{ graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }],
});

describe("AP invoice pipeline", () => {
  it("PO-based invoice with a clean 3-way match → READY, vendor + line matched", async () => {
    const r = await processInvoice(deps(), mail("sample-inv-po-001", "a"), 0);
    expect(r.invoiceType).toBe("PO_BASED");
    expect(r.internalState).toBe("READY");
    expect(r.normalized!.header.vendor!.erp_vendor_account!.value).toBe("VEND-ACME");
    expect(r.normalized!.lines[0]!.match_status).toBe("PO_MATCHED");
    expect(r.normalized!.lines[0]!.erp_item_id!.value).toBe("ITM-778");
    expect(r.businessKey).toBe("AP::USMF::VEND-ACME::INV5001");
    expect(r.stagedBlocked).toBe(true);
  });

  it("Non-PO invoice → Code & Approve line, NEEDS_REVIEW (reviewer GL-codes)", async () => {
    const r = await processInvoice(deps(), mail("sample-inv-nonpo-001", "b"), 0);
    expect(r.invoiceType).toBe("NON_PO");
    expect(r.internalState).toBe("NEEDS_REVIEW");
    expect(r.normalized!.lines).toHaveLength(1);
    expect(r.normalized!.lines[0]).toMatchObject({ is_code_and_approve: true, match_status: "GL_CODE_REQUIRED" });
    expect(r.normalized!.lines[0]!.amount!.value).toBe(1200);
    expect(r.findings.some((f) => f.code === "GL_CODE_REQUIRED" && f.blocking)).toBe(true);
  });

  it("invoiced quantity above goods received → OVER_RECEIPT, NEEDS_REVIEW", async () => {
    const r = await processInvoice(deps({ receipts: [{ companyId: "USMF", poNumber: "PO-100045", poLineRef: "1", receivedQty: 300 }] }), mail("sample-inv-po-001", "a"), 0);
    expect(r.internalState).toBe("NEEDS_REVIEW");
    expect(r.findings.some((f) => f.code === "THREEWAY_OVER_RECEIPT" && f.blocking)).toBe(true);
  });

  it("duplicate invoice (same vendor + invoice no) → DUPLICATE_REVIEW", async () => {
    const dedup = new InMemoryInvoiceDedup();
    const first = await processInvoice(deps({ dedup }), mail("sample-inv-po-001", "a"), 0);
    const second = await processInvoice(deps({ dedup }), mail("sample-inv-po-001", "b"), 0);
    expect(first.internalState).toBe("READY");
    expect(second.internalState).toBe("DUPLICATE_REVIEW");
    expect(second.findings.some((f) => f.code === "DUPLICATE_INVOICE")).toBe(true);
  });

  it("vendor not matched → VENDOR_UNMATCHED, NEEDS_REVIEW", async () => {
    const r = await processInvoice(deps({ vendors: [] }), mail("sample-inv-po-001", "a"), 0);
    expect(r.internalState).toBe("NEEDS_REVIEW");
    expect(r.findings.some((f) => f.code === "VENDOR_UNMATCHED" && f.blocking)).toBe(true);
  });

  it("malformed AI output → controlled FAILED", async () => {
    const r = await processInvoice(deps(), mail("sample-inv-bad", "c"), 0);
    expect(r.internalState).toBe("FAILED");
    expect(r.findings.some((f) => f.code === "FOUNDRY_OUTPUT_UNPARSEABLE")).toBe(true);
  });
});
