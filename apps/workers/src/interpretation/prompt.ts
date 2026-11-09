/**
 * Versioned, schema-constrained prompt for AI Foundry PO interpretation (spec §5). The prompt
 * version is recorded on every extracted order for traceability and learning (spec §10). The
 * model's output is validated downstream against the authoritative JSON Schema (docs/04) by
 * `normalize`, which degrades malformed output to a controlled failure (spec §16).
 */
import type { DiLayoutResult } from "../pipeline/ports.js";

export const PROMPT_VERSION = "po-interpret-2026.11.1";

export const SYSTEM_PROMPT = `You convert a purchase order's OCR output into a strict JSON object. Return ONLY JSON, no prose.

Shape (every leaf field is { "value": <normalized>, "raw": <original text or null>, "confidence": <0..1> }):
{
  "company": { "company_id": <legal entity / dataAreaId or "USMF">, "resolved_from": "document" },
  "header": {
    "customer": { "name": <field>, "erp_customer_account": { "value": null }, "match_status": "UNMATCHED" },
    "customer_po_number": <field>,
    "po_date": <field (ISO yyyy-mm-dd) or omit>,
    "requested_delivery_date": <field or omit>,
    "currency": <field (ISO 4217) >,
    "ship_to": <field>, "bill_to": <field>,
    "totals": { "subtotal": {"amount":<num|null>,"currency":<str|null>}, "tax": {...}, "grand_total": {...} }
  },
  "lines": [ { "customer_item_code": <field>, "description": <field>, "quantity": <field (number)>, "uom": <field>, "unit_price": <field (number)>, "extended_amount": <field (number)>, "match_status": "UNMATCHED" } ],
  "overall_confidence": <0..1>
}

Rules:
- NEVER invent an ERP customer account or item id. Leave erp_customer_account.value and any erp id null — matching happens later.
- If a value is not present in the document, use null (do not guess).
- Normalize dates to ISO yyyy-mm-dd and currency to ISO 4217.
- overall_confidence reflects how confident you are in the whole extraction.`;

export function buildDiContext(di: DiLayoutResult): string {
  const fieldLines = Object.entries(di.fields)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v.text)} (conf ${v.confidence.toFixed(2)})`)
    .join("\n");
  const lineRows = di.lines
    .map((row, i) => {
      const cols = Object.entries(row).map(([k, v]) => `${k}=${JSON.stringify(v.text)}`).join(", ");
      return `  line ${i + 1}: ${cols}`;
    })
    .join("\n");
  return [
    `Model: ${di.diModelVersion}; pages: ${di.pages}; quality: ${(di.documentQualityFlags ?? []).join(",") || "none"}`,
    "Header fields:",
    fieldLines || "  (none)",
    "Line items:",
    lineRows || "  (none)",
  ].join("\n");
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export function buildMessages(di: DiLayoutResult): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Document Intelligence output:\n${buildDiContext(di)}\n\nReturn the JSON object.` },
  ];
}
