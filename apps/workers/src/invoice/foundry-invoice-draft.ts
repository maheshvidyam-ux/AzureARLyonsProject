import type { Field, Money } from "@coa/po-schema";

/** Schema-constrained invoice interpretation AI Foundry returns, before server normalization. */
export interface FoundryInvoiceDraft {
  company: { company_id: string; resolved_from: "email_domain" | "document" | "manual" | "default" };
  header: {
    vendor: { name: Field<string | null>; tax_id?: Field<string | null>; erp_vendor_account: Field<string | null>; match_status: "UNMATCHED" };
    invoice_number: Field<string | null>;
    invoice_date?: Field<string | null>;
    po_number?: Field<string | null>;
    currency: Field<string | null>;
    payment_terms?: Field<string | null>;
    totals: { subtotal: Money; tax: Money; grand_total: Money };
  };
  lines: Array<{
    po_line_ref?: Field<string | null>;
    description: Field<string | null>;
    quantity?: Field<number | null>;
    uom?: Field<string | null>;
    unit_price?: Field<number | null>;
    amount: Field<number | null>;
  }>;
  overall_confidence: number;
}
