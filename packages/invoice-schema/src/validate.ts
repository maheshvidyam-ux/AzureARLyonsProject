import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { NormalizedInvoice } from "./types.js";

/**
 * Runtime schema for the normalized vendor invoice (AP). Kept compact and inline; the full
 * Field-wrapped shape is enforced loosely (the pipeline's structural validation + 3-way match do
 * the business checks). As with AR, this exists so malformed AI output degrades to a controlled
 * failure rather than propagating.
 */
const field = { type: "object", required: ["value"], properties: { value: {} }, additionalProperties: true } as const;

export const normalizedInvoiceSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://customer-order-automation/schemas/normalized-invoice.json",
  type: "object",
  required: ["document_id", "schema_version", "module_code", "invoice_type", "company", "header", "lines", "extraction"],
  additionalProperties: true,
  properties: {
    document_id: { type: "string" },
    schema_version: { type: "string" },
    module_code: { const: "AP_INVOICE" },
    invoice_type: { enum: ["PO_BASED", "NON_PO"] },
    company: { type: "object", required: ["company_id"], properties: { company_id: { type: "string" } } },
    header: {
      type: "object",
      properties: { vendor: { type: "object" }, invoice_number: field, invoice_date: field, po_number: field, currency: field, totals: { type: "object" } },
    },
    lines: { type: "array", items: { type: "object", required: ["line_id"], properties: { line_id: { type: "string" } } } },
    extraction: { type: "object", required: ["overall_confidence"], properties: { overall_confidence: { type: "number", minimum: 0, maximum: 1 } } },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const compiled: ValidateFunction = ajv.compile(normalizedInvoiceSchema);

export interface SchemaValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export function validateNormalizedInvoice(candidate: unknown): SchemaValidationResult {
  const valid = compiled(candidate) as boolean;
  return { valid, errors: valid ? [] : (compiled.errors ?? []) };
}

export function assertNormalizedInvoice(candidate: unknown): asserts candidate is NormalizedInvoice {
  const { valid, errors } = validateNormalizedInvoice(candidate);
  if (!valid) {
    const detail = errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
    throw new Error(`Object does not conform to NormalizedInvoice schema: ${detail}`);
  }
}
