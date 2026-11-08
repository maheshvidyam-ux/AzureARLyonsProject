/**
 * TypeScript types for the normalized Purchase Order (spec §5 / docs/04-po-schema.json).
 *
 * Hand-authored to mirror the JSON Schema. The schema file remains the single source of
 * truth and is enforced at runtime by `validateNormalizedPo`; these types are the
 * compile-time view. Keep them in sync when the schema changes (codegen is a later slice).
 */

export const SCHEMA_VERSION = "1.0.0";

export type PredictionSource = "DI" | "FOUNDRY" | "LEARNED_RULE" | "USER" | null;

export interface BoundingBox {
  page: number;
  /** x1,y1,...,xn,yn normalized 0..1 */
  polygon: number[];
}

export interface Evidence {
  page?: number | null;
  bounding_boxes?: BoundingBox[];
  /** Original OCR text, kept separate from the normalized value. */
  raw_text?: string | null;
  text_anchors?: string[];
  provider_confidence?: number | null;
  prediction_source?: PredictionSource;
  prediction_version?: string | null;
}

/** A value plus its evidence. `raw` is the original string; `value` is normalized. */
export interface Field<T = unknown> {
  value: T;
  raw?: string | null;
  confidence?: number | null;
  evidence?: Evidence;
}

export interface Money {
  amount: number | null;
  currency: string | null;
}

export type CustomerMatchStatus =
  | "EXACT"
  | "CROSS_REF"
  | "ALIAS"
  | "ADDRESS"
  | "HISTORY"
  | "FUZZY"
  | "UNMATCHED";

export type LineMatchStatus =
  | "EXACT_SKU"
  | "CUSTOMER_MAP"
  | "GTIN"
  | "PACK_UOM"
  | "DESC_SIMILARITY"
  | "UNMATCHED";

export interface OrderHeader {
  customer?: {
    /** null until matched; never invented */
    erp_customer_account?: Field<string | null>;
    name?: Field<string | null>;
    match_status?: CustomerMatchStatus;
  };
  customer_po_number?: Field<string | null>;
  /** Canonicalized PO# used in the duplicate business key. */
  normalized_po_number?: string | null;
  po_date?: Field<string | null>;
  requested_delivery_date?: Field<string | null>;
  bill_to?: Field<string | null>;
  ship_to?: Field<string | null>;
  currency?: Field<string | null>;
  payment_terms?: Field<string | null>;
  shipping_terms?: Field<string | null>;
  totals?: {
    subtotal?: Money;
    tax?: Money;
    grand_total?: Money;
  };
  special_instructions?: Field<string | null>;
}

export interface OrderLine {
  line_id: string;
  source_line_no?: number | null;
  customer_item_code?: Field<string | null>;
  description?: Field<string | null>;
  /** null until matched; no description-only blind auto-match */
  erp_item_id?: Field<string | null>;
  quantity?: Field<number | null>;
  uom?: Field<string | null>;
  unit_price?: Field<number | null>;
  extended_amount?: Field<number | null>;
  requested_date?: Field<string | null>;
  match_status?: LineMatchStatus;
}

export type DocumentQualityFlag =
  | "SCANNED"
  | "ROTATED"
  | "LOW_QUALITY"
  | "TABLE_SPANS_PAGES"
  | "UNKNOWN_TEMPLATE"
  | "MISSING_FIELDS";

export interface ExtractionMeta {
  di_model_version?: string | null;
  foundry_deployment?: string | null;
  foundry_prompt_version?: string | null;
  overall_confidence: number;
  multi_order_segment?: {
    segment_index: number;
    segment_total: number;
    ambiguous: boolean;
  } | null;
  document_quality_flags?: DocumentQualityFlag[];
}

export type FindingSeverity = "ERROR" | "WARNING";

export interface ValidationFinding {
  severity: FindingSeverity;
  code: string;
  field_path?: string | null;
  message?: string;
  /** true => cannot stage regardless of AI confidence */
  blocking: boolean;
}

export interface Company {
  company_id: string;
  resolved_from?: "email_domain" | "document" | "manual" | "default";
}

export interface NormalizedPurchaseOrder {
  document_id: string;
  order_id?: string | null;
  schema_version: string;
  company: Company;
  header: OrderHeader;
  lines: OrderLine[];
  extraction: ExtractionMeta;
  validation?: ValidationFinding[];
}
