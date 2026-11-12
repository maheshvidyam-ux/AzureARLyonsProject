/**
 * Normalize an AI Foundry invoice interpretation into a NormalizedInvoice (AP_INVOICE). Decides
 * PO_BASED vs NON_PO (a PO number on the invoice ⇒ PO_BASED), and for NON_PO synthesizes a single
 * "C&A" (Code & Approve) line holding the invoice total for a reviewer to GL-code. Malformed AI
 * output degrades to a controlled failure (never throws out of the stage).
 */
import { INVOICE_SCHEMA_VERSION, validateNormalizedInvoice, type InvoiceLine, type NormalizedInvoice } from "@coa/invoice-schema";
import { normalizeInvoiceNumber } from "@coa/domain";
import type { ValidationFinding } from "@coa/po-schema";
import type { FoundryInvoiceDraft } from "./foundry-invoice-draft.js";
import type { DiLayoutResult, FoundryResult } from "../pipeline/ports.js";

export type NormalizeInvoiceResult =
  | { ok: true; invoice: NormalizedInvoice }
  | { ok: false; reason: "UNPARSEABLE" | "SCHEMA_INVALID"; finding: ValidationFinding; detail: string };

export function normalizeInvoice(input: { documentId: string; di: DiLayoutResult; foundry: FoundryResult }): NormalizeInvoiceResult {
  let draft: Partial<FoundryInvoiceDraft>;
  try {
    draft = JSON.parse(input.foundry.rawJson) as Partial<FoundryInvoiceDraft>;
  } catch (err) {
    return { ok: false, reason: "UNPARSEABLE", detail: (err as Error).message, finding: fail("FOUNDRY_OUTPUT_UNPARSEABLE", "AI Foundry returned invalid JSON for this invoice.") };
  }

  try {
    const header = draft.header ?? ({} as NonNullable<FoundryInvoiceDraft["header"]>);
    const invoiceType: NormalizedInvoice["invoice_type"] = header.po_number?.value ? "PO_BASED" : "NON_PO";
    const grand = header.totals?.grand_total;

    const lines: InvoiceLine[] =
      invoiceType === "PO_BASED"
        ? (draft.lines ?? []).map((l, i) => ({
            line_id: `L${i + 1}`,
            source_line_no: i + 1,
            po_line_ref: l.po_line_ref,
            erp_item_id: { value: null },
            description: l.description,
            quantity: l.quantity,
            uom: l.uom,
            unit_price: l.unit_price,
            amount: l.amount,
            match_status: "UNMATCHED",
          }))
        : [
            {
              line_id: "L1",
              source_line_no: 1,
              description: { value: "Code & Approve" },
              gl_account: { value: null }, // reviewer codes it
              amount: { value: grand?.amount ?? null },
              match_status: "GL_CODE_REQUIRED",
              is_code_and_approve: true,
            },
          ];

    const invoice: NormalizedInvoice = {
      document_id: input.documentId,
      invoice_id: null,
      schema_version: INVOICE_SCHEMA_VERSION,
      module_code: "AP_INVOICE",
      invoice_type: invoiceType,
      company: draft.company ?? { company_id: "" },
      header: {
        vendor: header.vendor
          ? { erp_vendor_account: header.vendor.erp_vendor_account, name: header.vendor.name, tax_id: header.vendor.tax_id, match_status: "UNMATCHED" }
          : undefined,
        invoice_number: header.invoice_number,
        normalized_invoice_number: normalizeInvoiceNumber(header.invoice_number?.value ?? null),
        invoice_date: header.invoice_date,
        po_number: header.po_number,
        currency: header.currency,
        payment_terms: header.payment_terms,
        totals: header.totals,
      },
      lines,
      extraction: {
        di_model_version: input.di.diModelVersion,
        foundry_deployment: input.foundry.deployment,
        foundry_prompt_version: input.foundry.promptVersion,
        overall_confidence: typeof draft.overall_confidence === "number" ? draft.overall_confidence : 0,
      },
      validation: [],
    };

    const { valid, errors } = validateNormalizedInvoice(invoice);
    if (!valid) {
      const detail = errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
      return { ok: false, reason: "SCHEMA_INVALID", detail, finding: fail("INVOICE_OUTPUT_SCHEMA_INVALID", `AI invoice output did not conform to the schema: ${detail}`) };
    }
    return { ok: true, invoice };
  } catch (err) {
    return { ok: false, reason: "SCHEMA_INVALID", detail: (err as Error).message, finding: fail("INVOICE_OUTPUT_SCHEMA_INVALID", (err as Error).message) };
  }
}

function fail(code: string, message: string): ValidationFinding {
  return { severity: "ERROR", code, field_path: null, message, blocking: true };
}
