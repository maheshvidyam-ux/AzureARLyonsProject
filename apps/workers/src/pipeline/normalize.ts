/**
 * Normalization stage (spec §5): turn the AI Foundry interpretation into a
 * NormalizedPurchaseOrder (docs/04) with server-owned fields filled in, then enforce the
 * JSON Schema. Raw (model) and normalized (server) values are kept separate per the
 * schema's Field wrapper.
 *
 * Failure handling (spec §16 "AI returns malformed JSON"): a model output that cannot be
 * parsed, or that does not conform to the schema, degrades to a controlled blocking
 * finding — never a thrown exception out of the stage.
 */
import {
  SCHEMA_VERSION,
  validateNormalizedPo,
  type NormalizedPurchaseOrder,
  type OrderLine,
  type ValidationFinding,
} from "@coa/po-schema";
import { normalizePoNumber } from "@coa/domain";
import type { FoundryPoDraft } from "./foundry-draft.js";
import type { DiLayoutResult, FoundryResult } from "./ports.js";

export type NormalizeResult =
  | { ok: true; po: NormalizedPurchaseOrder }
  | { ok: false; reason: "UNPARSEABLE" | "SCHEMA_INVALID"; finding: ValidationFinding; detail: string };

export function normalize(input: {
  documentId: string;
  di: DiLayoutResult;
  foundry: FoundryResult;
}): NormalizeResult {
  // 1. Parse the model output.
  let draft: Partial<FoundryPoDraft>;
  try {
    draft = JSON.parse(input.foundry.rawJson) as Partial<FoundryPoDraft>;
  } catch (err) {
    return {
      ok: false,
      reason: "UNPARSEABLE",
      detail: (err as Error).message,
      finding: {
        severity: "ERROR",
        code: "FOUNDRY_OUTPUT_UNPARSEABLE",
        field_path: null,
        message: "AI Foundry returned output that is not valid JSON; cannot interpret this document.",
        blocking: true,
      },
    };
  }

  // 2. Assemble the normalized PO with server-owned fields.
  let po: NormalizedPurchaseOrder;
  try {
    const header = draft.header ?? ({} as NonNullable<FoundryPoDraft["header"]>);
    const customerPo = header.customer_po_number?.value ?? null;

    const lines: OrderLine[] = (draft.lines ?? []).map((l, i) => ({
      line_id: `L${i + 1}`,
      source_line_no: i + 1,
      customer_item_code: l.customer_item_code,
      description: l.description,
      erp_item_id: { value: null }, // matching is Phase 3; never invented here
      quantity: l.quantity,
      uom: l.uom,
      unit_price: l.unit_price,
      extended_amount: l.extended_amount,
      match_status: l.match_status ?? "UNMATCHED",
    }));

    po = {
      document_id: input.documentId,
      order_id: null,
      schema_version: SCHEMA_VERSION,
      company: draft.company ?? ({ company_id: "" } as FoundryPoDraft["company"]),
      header: {
        customer: header.customer
          ? {
              erp_customer_account: header.customer.erp_customer_account,
              name: header.customer.name,
              match_status: header.customer.match_status ?? "UNMATCHED",
            }
          : undefined,
        customer_po_number: header.customer_po_number,
        normalized_po_number: normalizePoNumber(customerPo),
        po_date: header.po_date,
        requested_delivery_date: header.requested_delivery_date,
        bill_to: header.bill_to,
        ship_to: header.ship_to,
        currency: header.currency,
        totals: header.totals,
      },
      lines,
      extraction: {
        di_model_version: input.di.diModelVersion,
        foundry_deployment: input.foundry.deployment,
        foundry_prompt_version: input.foundry.promptVersion,
        overall_confidence: typeof draft.overall_confidence === "number" ? draft.overall_confidence : 0,
        document_quality_flags: input.di.documentQualityFlags as NormalizedPurchaseOrder["extraction"]["document_quality_flags"],
      },
      validation: [],
    };
  } catch (err) {
    return {
      ok: false,
      reason: "SCHEMA_INVALID",
      detail: (err as Error).message,
      finding: schemaInvalidFinding((err as Error).message),
    };
  }

  // 3. Enforce the JSON Schema (the runtime source of truth for the AI output).
  const { valid, errors } = validateNormalizedPo(po);
  if (!valid) {
    const detail = errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
    return { ok: false, reason: "SCHEMA_INVALID", detail, finding: schemaInvalidFinding(detail) };
  }

  return { ok: true, po };
}

function schemaInvalidFinding(detail: string): ValidationFinding {
  return {
    severity: "ERROR",
    code: "FOUNDRY_OUTPUT_SCHEMA_INVALID",
    field_path: null,
    message: `AI output did not conform to the normalized-PO schema: ${detail}`,
    blocking: true,
  };
}
