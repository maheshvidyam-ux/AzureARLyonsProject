/**
 * TEST-ENV-ONLY recorded AI Foundry interpretations (spec §18 — quarantined mock).
 *
 * Each entry yields either a well-formed `draft` (serialized to rawJson by the mock
 * client) or a `malformedRaw` string that is deliberately NOT valid JSON, to exercise
 * the §16 "AI returns malformed JSON" degradation path.
 */
export interface FoundryFixture {
  deployment: string;
  promptVersion: string;
  /** Serialized to rawJson by the mock client. AR uses FoundryPoDraft, AP uses FoundryInvoiceDraft. */
  draft?: unknown;
  malformedRaw?: string;
}

const ev = (page: number, polygon: number[], confidence: number, raw: string) => ({
  page,
  bounding_boxes: [{ page, polygon }],
  raw_text: raw,
  provider_confidence: confidence,
  prediction_source: "FOUNDRY" as const,
  prediction_version: "po-interpret-2026.11.1",
});

export const FOUNDRY_RESPONSES: Record<string, FoundryFixture> = {
  // Clean PO → should normalize, pass validation, reach READY (and STOP before staging).
  "sample-po-001": {
    deployment: "gpt-4o-po-interpret",
    promptVersion: "po-interpret-2026.11.1",
    draft: {
      company: { company_id: "USMF", resolved_from: "email_domain" },
      header: {
        customer: {
          name: { value: "Acme Industrial Supply", raw: "Acme Industrial Supply", confidence: 0.98, evidence: ev(1, [0.08, 0.06, 0.48, 0.06, 0.48, 0.09, 0.08, 0.09], 0.98, "Acme Industrial Supply") },
          erp_customer_account: { value: null, confidence: null, evidence: ev(1, [], 0, "") },
          match_status: "UNMATCHED",
        },
        customer_po_number: { value: "PO-100045", raw: "PO-100045", confidence: 0.97, evidence: ev(1, [0.7, 0.1, 0.9, 0.1, 0.9, 0.125, 0.7, 0.125], 0.97, "PO-100045") },
        po_date: { value: "2026-10-28", raw: "2026-10-28", confidence: 0.95, evidence: ev(1, [0.7, 0.14, 0.9, 0.14, 0.9, 0.165, 0.7, 0.165], 0.95, "2026-10-28") },
        currency: { value: "USD", raw: "USD", confidence: 0.99, evidence: ev(1, [0.7, 0.18, 0.78, 0.18, 0.78, 0.2, 0.7, 0.2], 0.99, "USD") },
        ship_to: { value: "Lyons DC 4, 100 Dock Rd, Columbus OH", raw: "Lyons DC 4, 100 Dock Rd, Columbus OH", confidence: 0.9, evidence: ev(1, [0.08, 0.2, 0.53, 0.2, 0.53, 0.26, 0.08, 0.26], 0.9, "Lyons DC 4") },
        bill_to: { value: "Acme AP, PO Box 22, Columbus OH", raw: "Acme AP, PO Box 22, Columbus OH", confidence: 0.9, evidence: ev(1, [0.55, 0.2, 0.95, 0.2, 0.95, 0.26, 0.55, 0.26], 0.9, "Acme AP") },
        totals: {
          subtotal: { amount: 1250.0, currency: "USD" },
          tax: { amount: 0.0, currency: "USD" },
          grand_total: { amount: 1250.0, currency: "USD" },
        },
      },
      lines: [
        {
          customer_item_code: { value: "ACM-778", raw: "ACM-778", confidence: 0.96, evidence: ev(1, [0.08, 0.45, 0.2, 0.45, 0.2, 0.47, 0.08, 0.47], 0.96, "ACM-778") },
          description: { value: "1/2in Hex Bolt, Zinc", raw: "1/2in Hex Bolt, Zinc", confidence: 0.94, evidence: ev(1, [0.22, 0.45, 0.52, 0.45, 0.52, 0.47, 0.22, 0.47], 0.94, "1/2in Hex Bolt, Zinc") },
          quantity: { value: 500, raw: "500", confidence: 0.97, evidence: ev(1, [0.55, 0.45, 0.62, 0.45, 0.62, 0.47, 0.55, 0.47], 0.97, "500") },
          uom: { value: "EA", raw: "EA", confidence: 0.95, evidence: ev(1, [0.64, 0.45, 0.7, 0.45, 0.7, 0.47, 0.64, 0.47], 0.95, "EA") },
          unit_price: { value: 1.5, raw: "1.50", confidence: 0.95, evidence: ev(1, [0.72, 0.45, 0.82, 0.45, 0.82, 0.47, 0.72, 0.47], 0.95, "1.50") },
          extended_amount: { value: 750.0, raw: "750.00", confidence: 0.95, evidence: ev(1, [0.84, 0.45, 0.94, 0.45, 0.94, 0.47, 0.84, 0.47], 0.95, "750.00") },
          match_status: "UNMATCHED",
        },
        {
          customer_item_code: { value: "ACM-902", raw: "ACM-902", confidence: 0.95, evidence: ev(1, [0.08, 0.48, 0.2, 0.48, 0.2, 0.5, 0.08, 0.5], 0.95, "ACM-902") },
          description: { value: "Flat Washer, Zinc", raw: "Flat Washer, Zinc", confidence: 0.93, evidence: ev(1, [0.22, 0.48, 0.52, 0.48, 0.52, 0.5, 0.22, 0.5], 0.93, "Flat Washer, Zinc") },
          quantity: { value: 1000, raw: "1000", confidence: 0.97, evidence: ev(1, [0.55, 0.48, 0.62, 0.48, 0.62, 0.5, 0.55, 0.5], 0.97, "1000") },
          uom: { value: "EA", raw: "EA", confidence: 0.95, evidence: ev(1, [0.64, 0.48, 0.7, 0.48, 0.7, 0.5, 0.64, 0.5], 0.95, "EA") },
          unit_price: { value: 0.5, raw: "0.50", confidence: 0.95, evidence: ev(1, [0.72, 0.48, 0.82, 0.48, 0.82, 0.5, 0.72, 0.5], 0.95, "0.50") },
          extended_amount: { value: 500.0, raw: "500.00", confidence: 0.95, evidence: ev(1, [0.84, 0.48, 0.94, 0.48, 0.94, 0.5, 0.84, 0.5], 0.95, "500.00") },
          match_status: "UNMATCHED",
        },
      ],
      overall_confidence: 0.95,
    },
  },

  // Problem PO → blocking structural findings (zero qty, missing po_date) → NEEDS_REVIEW.
  "sample-po-002": {
    deployment: "gpt-4o-po-interpret",
    promptVersion: "po-interpret-2026.11.1",
    draft: {
      company: { company_id: "USMF", resolved_from: "email_domain" },
      header: {
        customer: {
          name: { value: "Unknown Buyer", raw: "Unknown Buyer", confidence: 0.5, evidence: ev(1, [0.08, 0.06, 0.4, 0.06, 0.4, 0.09, 0.08, 0.09], 0.5, "Unknown Buyer") },
          erp_customer_account: { value: null, confidence: null },
          match_status: "UNMATCHED",
        },
        customer_po_number: { value: "PO-100046", raw: "PO-100046", confidence: 0.6, evidence: ev(1, [0.7, 0.1, 0.9, 0.1, 0.9, 0.125, 0.7, 0.125], 0.6, "PO-100046") },
        // po_date intentionally omitted -> REQUIRED_PO_DATE_MISSING (warning)
        currency: { value: "USD", raw: "USD", confidence: 0.9, evidence: ev(1, [0.7, 0.18, 0.78, 0.18, 0.78, 0.2, 0.7, 0.2], 0.9, "USD") },
        ship_to: { value: "Lyons DC 4, Columbus OH", raw: "Lyons DC 4, Columbus OH", confidence: 0.7, evidence: ev(1, [0.08, 0.2, 0.53, 0.2, 0.53, 0.26, 0.08, 0.26], 0.7, "Lyons DC 4") },
        totals: {
          subtotal: { amount: 0.0, currency: "USD" },
          tax: { amount: 0.0, currency: "USD" },
          grand_total: { amount: 0.0, currency: "USD" },
        },
      },
      lines: [
        {
          customer_item_code: { value: "ACM-778", raw: "ACM-778", confidence: 0.8, evidence: ev(1, [0.08, 0.45, 0.2, 0.45, 0.2, 0.47, 0.08, 0.47], 0.8, "ACM-778") },
          description: { value: "1/2in Hex Bolt, Zinc", raw: "1/2in Hex Bolt, Zinc", confidence: 0.8, evidence: ev(1, [0.22, 0.45, 0.52, 0.45, 0.52, 0.47, 0.22, 0.47], 0.8, "1/2in Hex Bolt, Zinc") },
          quantity: { value: 0, raw: "0", confidence: 0.4, evidence: ev(1, [0.55, 0.45, 0.62, 0.45, 0.62, 0.47, 0.55, 0.47], 0.4, "0") },
          uom: { value: "EA", raw: "EA", confidence: 0.8, evidence: ev(1, [0.64, 0.45, 0.7, 0.45, 0.7, 0.47, 0.64, 0.47], 0.8, "EA") },
          unit_price: { value: 1.5, raw: "1.50", confidence: 0.8, evidence: ev(1, [0.72, 0.45, 0.82, 0.45, 0.82, 0.47, 0.72, 0.47], 0.8, "1.50") },
          extended_amount: { value: 0.0, raw: "0.00", confidence: 0.8, evidence: ev(1, [0.84, 0.45, 0.94, 0.45, 0.94, 0.47, 0.84, 0.47], 0.8, "0.00") },
          match_status: "UNMATCHED",
        },
      ],
      overall_confidence: 0.55,
    },
  },

  // Malformed model output (truncated JSON) → unparseable → controlled FAILED, no crash.
  "sample-po-003": {
    deployment: "gpt-4o-po-interpret",
    promptVersion: "po-interpret-2026.11.1",
    malformedRaw: '{"company":{"company_id":"USMF"},"header":{"customer_po_number":{"value":"PO-100047"',
  },

  // --- AP vendor invoices (FoundryInvoiceDraft shape) ---
  "sample-inv-po-001": {
    deployment: "gpt-4o-invoice",
    promptVersion: "invoice-interpret-2026.11.1",
    draft: {
      company: { company_id: "USMF", resolved_from: "document" },
      header: {
        vendor: { name: { value: "Acme Industrial Supply" }, erp_vendor_account: { value: null }, match_status: "UNMATCHED" },
        invoice_number: { value: "INV-5001" },
        invoice_date: { value: "2026-11-02" },
        po_number: { value: "PO-100045" },
        currency: { value: "USD" },
        totals: { subtotal: { amount: 750, currency: "USD" }, tax: { amount: 0, currency: "USD" }, grand_total: { amount: 750, currency: "USD" } },
      },
      lines: [{ po_line_ref: { value: "1" }, description: { value: "1/2in Hex Bolt, Zinc" }, quantity: { value: 500 }, uom: { value: "EA" }, unit_price: { value: 1.5 }, amount: { value: 750 } }],
      overall_confidence: 0.95,
    },
  },
  "sample-inv-nonpo-001": {
    deployment: "gpt-4o-invoice",
    promptVersion: "invoice-interpret-2026.11.1",
    draft: {
      company: { company_id: "USMF", resolved_from: "document" },
      header: {
        vendor: { name: { value: "Globex Corporation" }, erp_vendor_account: { value: null }, match_status: "UNMATCHED" },
        invoice_number: { value: "GBX-9007" },
        invoice_date: { value: "2026-11-03" },
        currency: { value: "USD" },
        totals: { subtotal: { amount: 1200, currency: "USD" }, tax: { amount: 0, currency: "USD" }, grand_total: { amount: 1200, currency: "USD" } },
      },
      lines: [],
      overall_confidence: 0.9,
    },
  },
  "sample-inv-bad": {
    deployment: "gpt-4o-invoice",
    promptVersion: "invoice-interpret-2026.11.1",
    malformedRaw: '{"company":{"company_id":"USMF"},"header":{"invoice_number":{"value":"INV-BAD"',
  },

  // --- customer PO sent as Excel (routed through the spreadsheet extractor) ---
  "sample-po-xl-001": {
    deployment: "gpt-4o-po-interpret",
    promptVersion: "po-interpret-2026.11.1",
    draft: {
      company: { company_id: "USMF", resolved_from: "document" },
      header: {
        customer: { name: { value: "Acme Industrial Supply" }, erp_customer_account: { value: null }, match_status: "UNMATCHED" },
        customer_po_number: { value: "PO-XL-7788" },
        po_date: { value: "2026-11-04" },
        currency: { value: "USD" },
        totals: { subtotal: { amount: 1250, currency: "USD" }, tax: { amount: 0, currency: "USD" }, grand_total: { amount: 1250, currency: "USD" } },
      },
      lines: [
        { customer_item_code: { value: "ACM-778" }, description: { value: "1/2in Hex Bolt" }, quantity: { value: 500 }, uom: { value: "EA" }, unit_price: { value: 1.5 }, extended_amount: { value: 750 }, match_status: "UNMATCHED" },
        { customer_item_code: { value: "ACM-902" }, description: { value: "Flat Washer" }, quantity: { value: 1000 }, uom: { value: "EA" }, unit_price: { value: 0.5 }, extended_amount: { value: 500 }, match_status: "UNMATCHED" },
      ],
      overall_confidence: 0.9,
    },
  },
};
