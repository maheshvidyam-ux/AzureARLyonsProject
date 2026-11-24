/**
 * AP invoice PO resolution — prefix-tolerant ("PO-" is often dropped on the invoice), vendor-first,
 * with a cross-vendor PO lookup as the fallback when the vendor is unmatched. A matched vendor is
 * never silently switched to another vendor's PO.
 */
import { describe, expect, it } from "vitest";
import { canonicalPoNumber } from "@coa/domain";
import { InMemoryInvoiceMasterReader } from "@coa/fabric-read";
import { processInvoice, resolvePurchaseOrder, InMemoryInvoiceDedup, type InvoicePipelineDeps } from "../../apps/workers/src/invoice/index.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_VENDORS, SAMPLE_PO_LINES, SAMPLE_RECEIPTS } from "../../mocks/fabric/sample-invoice-masters.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

const masters = () => new InMemoryInvoiceMasterReader({ vendors: SAMPLE_VENDORS, poLines: SAMPLE_PO_LINES, receipts: SAMPLE_RECEIPTS });

describe("canonicalPoNumber", () => {
  it("drops a leading PO prefix so a dropped 'PO-' still matches", () => {
    expect(canonicalPoNumber("PO-100045")).toBe("100045");
    expect(canonicalPoNumber("PO100045")).toBe("100045");
    expect(canonicalPoNumber("100045")).toBe("100045");
    expect(canonicalPoNumber("po-100045")).toBe("100045");
  });
  it("leaves a non-numeric PO id intact and handles null", () => {
    expect(canonicalPoNumber("POLY-7")).toBe("POLY7"); // 'PO' not followed by a digit → not stripped
    expect(canonicalPoNumber(null)).toBeNull();
  });
});

describe("resolvePurchaseOrder", () => {
  it("vendor-first: finds the matched vendor's PO even when the invoice dropped the 'PO-'", async () => {
    const r = await resolvePurchaseOrder(masters(), { companyId: "USMF", erpVendorAccount: "VEND-ACME", poNumberRaw: "100045" });
    expect(r.via).toBe("vendor_po");
    expect(r.poNumber).toBe("PO-100045");
    expect(r.erpVendorAccount).toBe("VEND-ACME");
    expect(r.poLines).toHaveLength(2);
  });

  it("fallback: when the vendor is unmatched, looks the PO up and derives the vendor from it", async () => {
    const r = await resolvePurchaseOrder(masters(), { companyId: "USMF", erpVendorAccount: null, poNumberRaw: "PO-100045" });
    expect(r.via).toBe("po_lookup");
    expect(r.erpVendorAccount).toBe("VEND-ACME");
    expect(r.poLines).toHaveLength(2);
  });

  it("never switches a matched vendor to another vendor's PO (mismatch → none)", async () => {
    const r = await resolvePurchaseOrder(masters(), { companyId: "USMF", erpVendorAccount: "VEND-GLOBEX", poNumberRaw: "100045" });
    expect(r.via).toBe("none");
    expect(r.poNumber).toBeNull();
    expect(r.erpVendorAccount).toBe("VEND-GLOBEX");
  });
});

describe("invoice pipeline — vendor derived from PO", () => {
  it("an unreadable vendor still resolves via the PO and the invoice clears VENDOR_UNMATCHED", async () => {
    // Empty vendor master → matchVendor fails; the PO (PO-100045) still identifies VEND-ACME.
    const deps: InvoicePipelineDeps = {
      blob: new InMemoryBlobStore(),
      di: new MockDocumentIntelligenceClient(),
      foundry: new MockFoundryClient(),
      masters: new InMemoryInvoiceMasterReader({ vendors: [], poLines: SAMPLE_PO_LINES, receipts: SAMPLE_RECEIPTS }),
      dedup: new InMemoryInvoiceDedup(),
    };
    const mail: GraphMailMessage = { graphMessageId: "gm-x", mailbox: "ap@lyons", sender: "ap@acme.example.com", receivedAt: "2026-11-02T09:00:00Z", subject: "Invoice", attachments: [{ graphAttachmentId: "ga-x", filename: "sample-inv-po-001.pdf", contentType: "application/pdf", contentBase64: Buffer.from("x").toString("base64") }] };

    const r = await processInvoice(deps, mail, 0);
    expect(r.normalized!.header.vendor!.erp_vendor_account!.value).toBe("VEND-ACME");
    expect(r.normalized!.header.vendor!.match_status).toBe("PO_DERIVED");
    expect(r.findings.some((f) => f.code === "VENDOR_UNMATCHED")).toBe(false);
    expect(r.findings.some((f) => f.code === "VENDOR_RESOLVED_FROM_PO")).toBe(true);
    expect(r.internalState).toBe("READY"); // vendor resolved + 3-way matched
  });
});
