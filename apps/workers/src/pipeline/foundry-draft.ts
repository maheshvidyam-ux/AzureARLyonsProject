import type { Field, Money } from "@coa/po-schema";

/**
 * The schema-constrained interpretation AI Foundry returns (spec §5), BEFORE server-side
 * normalization. It is Field-wrapped and carries evidence, but does NOT include
 * server-owned fields (document_id, schema_version, normalized_po_number, line_id,
 * extraction metadata) — those are assembled deterministically in `normalize`.
 *
 * AI never invents IDs: an unknown erp_customer_account is `{ value: null }`, never a
 * fabricated account. Customer/item matching against Fabric masters is Phase 3; here
 * everything is UNMATCHED by construction.
 */
export interface FoundryPoDraft {
  company: {
    company_id: string;
    resolved_from: "email_domain" | "document" | "manual" | "default";
  };
  header: {
    customer: {
      name: Field<string | null>;
      erp_customer_account: Field<string | null>;
      match_status: "UNMATCHED";
    };
    customer_po_number: Field<string | null>;
    po_date?: Field<string | null>;
    requested_delivery_date?: Field<string | null>;
    currency: Field<string | null>;
    ship_to?: Field<string | null>;
    bill_to?: Field<string | null>;
    totals: {
      subtotal: Money;
      tax: Money;
      grand_total: Money;
    };
  };
  lines: Array<{
    customer_item_code: Field<string | null>;
    description: Field<string | null>;
    quantity: Field<number | null>;
    uom: Field<string | null>;
    unit_price: Field<number | null>;
    extended_amount: Field<number | null>;
    match_status: "UNMATCHED";
  }>;
  overall_confidence: number;
}
