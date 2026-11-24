/**
 * Versioned, schema-constrained prompt for AI Foundry VENDOR INVOICE interpretation (spec §5, AP).
 * The model's output is the FoundryInvoiceDraft shape and is validated downstream by
 * normalizeInvoice (malformed output → controlled failure). Reuses the shared DI-context builder.
 */
import type { DiLayoutResult } from "../pipeline/ports.js";
import { buildDiContext, type ChatMessage } from "../interpretation/prompt.js";

export const INVOICE_PROMPT_VERSION = "invoice-interpret-2026.11.1";

export const INVOICE_SYSTEM_PROMPT = `You convert a vendor invoice's OCR output into a strict JSON object. Return ONLY JSON, no prose.

Shape (every leaf field is { "value": <normalized>, "raw": <original text or null>, "confidence": <0..1> }):
{
  "company": { "company_id": <legal entity / dataAreaId or "USMF">, "resolved_from": "document" },
  "header": {
    "vendor": { "name": <field>, "tax_id": <field or omit>, "erp_vendor_account": { "value": null }, "match_status": "UNMATCHED" },
    "invoice_number": <field>,
    "invoice_date": <field (ISO yyyy-mm-dd) or omit>,
    "po_number": <field or omit — the purchase order this invoice bills against, if any>,
    "currency": <field (ISO 4217)>,
    "payment_terms": <field or omit>,
    "totals": { "subtotal": {"amount":<num|null>,"currency":<str|null>}, "tax": {...}, "grand_total": {...} }
  },
  "lines": [ { "po_line_ref": <field or omit>, "description": <field>, "quantity": <field (number)>, "uom": <field>, "unit_price": <field (number)>, "amount": <field (number)> } ],
  "overall_confidence": <0..1>
}

Rules:
- NEVER invent an ERP vendor account. Leave erp_vendor_account.value null — vendor matching happens later.
- Copy the PO number EXACTLY as printed; do NOT add or strip a "PO-" prefix (PO resolution normalizes it).
- A non-PO invoice (no purchase order) simply has po_number null — do not fabricate one.
- If a value is not present in the document, use null (do not guess).
- Normalize dates to ISO yyyy-mm-dd and currency to ISO 4217.
- overall_confidence reflects how confident you are in the whole extraction.`;

export function buildInvoiceMessages(di: DiLayoutResult): ChatMessage[] {
  return [
    { role: "system", content: INVOICE_SYSTEM_PROMPT },
    { role: "user", content: `Document Intelligence output:\n${buildDiContext(di)}\n\nReturn the JSON object.` },
  ];
}
