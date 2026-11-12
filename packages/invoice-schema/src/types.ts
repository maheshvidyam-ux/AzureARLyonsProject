/**
 * Normalized vendor invoice (AP_INVOICE module) — the schema-constrained output of AI Foundry
 * interpretation of a vendor invoice, mirroring the AR NormalizedPurchaseOrder. Reuses the
 * shared Field/Money/Evidence primitives from @coa/po-schema.
 *
 * Two shapes:
 *  - PO_BASED: references a PO; lines carry po_line_ref/item/qty/price for 3-way matching.
 *  - NON_PO (GL-coded): no PO; a single synthesized "C&A" (Code & Approve) line holds the invoice
 *    total for a reviewer to GL-code. AI never invents a vendor account or GL — unknown => null.
 */
import type { Field, Money, ValidationFinding } from "@coa/po-schema";

export const INVOICE_SCHEMA_VERSION = "1.0.0";

export type InvoiceType = "PO_BASED" | "NON_PO";
export type VendorMatchStatus = "EXACT" | "CROSS_REF" | "ALIAS" | "ADDRESS" | "TAX_ID" | "FUZZY" | "UNMATCHED";
export type InvoiceLineMatchStatus = "PO_MATCHED" | "QTY_VARIANCE" | "PRICE_VARIANCE" | "OVER_RECEIPT" | "NO_PO_LINE" | "GL_CODE_REQUIRED" | "UNMATCHED";

export interface InvoiceVendor {
  /** null until matched; never invented */
  erp_vendor_account?: Field<string | null>;
  name?: Field<string | null>;
  tax_id?: Field<string | null>;
  match_status?: VendorMatchStatus;
}

export interface InvoiceHeader {
  vendor?: InvoiceVendor;
  invoice_number?: Field<string | null>;
  /** canonicalized invoice number — component of the AP dedup key */
  normalized_invoice_number?: string | null;
  invoice_date?: Field<string | null>;
  /** referenced PO (PO_BASED invoices) */
  po_number?: Field<string | null>;
  currency?: Field<string | null>;
  payment_terms?: Field<string | null>;
  totals?: {
    subtotal?: Money;
    tax?: Money;
    grand_total?: Money;
  };
}

export interface InvoiceLine {
  line_id: string;
  source_line_no?: number | null;
  /** PO line reference (PO_BASED) */
  po_line_ref?: Field<string | null>;
  erp_item_id?: Field<string | null>;
  /** GL account (NON_PO) — null on the C&A line until a reviewer codes it */
  gl_account?: Field<string | null>;
  description?: Field<string | null>;
  quantity?: Field<number | null>;
  uom?: Field<string | null>;
  unit_price?: Field<number | null>;
  amount?: Field<number | null>;
  match_status?: InvoiceLineMatchStatus;
  /** true for a synthesized Code & Approve line (NON_PO total). */
  is_code_and_approve?: boolean;
}

export interface NormalizedInvoice {
  document_id: string;
  invoice_id?: string | null;
  schema_version: string;
  module_code: "AP_INVOICE";
  invoice_type: InvoiceType;
  company: { company_id: string; resolved_from?: "email_domain" | "document" | "manual" | "default" };
  header: InvoiceHeader;
  lines: InvoiceLine[];
  extraction: {
    di_model_version?: string | null;
    foundry_deployment?: string | null;
    foundry_prompt_version?: string | null;
    overall_confidence: number;
  };
  validation?: ValidationFinding[];
}
