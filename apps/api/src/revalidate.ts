/**
 * Revalidate a (corrected) order. A CSR fixes fields in the reviewer UI; this re-runs the SAME
 * structural + master-matching rules the ingestion pipeline uses (@coa/evaluation) against the
 * corrected values, replaces the validation findings, writes back any newly-matched ERP account /
 * items, and recomputes the state — so fixing the customer actually clears CUSTOMER_UNMATCHED and
 * flips NEEDS_REVIEW → READY. Optimistic concurrency is enforced via the persisted row_version.
 *
 * Only NEEDS_REVIEW / READY orders are revalidatable — a duplicate claim, a staged/approved order,
 * or a rejected one are not re-openable this way.
 */
import { toSimpleStatus, type InternalState } from "@coa/domain";
import { toValidationWrites, type OrderReviewDetail, type Persistence, type RevalidationWrite } from "@coa/persistence";
import type { MasterDataReader } from "@coa/fabric-read";
import { evaluateOrder } from "@coa/evaluation";
import type { Field, NormalizedPurchaseOrder, ValidationFinding } from "@coa/po-schema";

const REVALIDATABLE = new Set(["NEEDS_REVIEW", "READY"]);

export type RevalidateOutcome =
  | { status: "OK"; rowVersion: number; internalState: string; findings: ValidationFinding[] }
  | { status: "CONFLICT"; rowVersion: number }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_STATE"; internalState: string };

export interface RevalidateDeps {
  persistence: Persistence;
  masters?: MasterDataReader;
}

export async function revalidateOrder(deps: RevalidateDeps, orderId: string, expectedRowVersion: number, actor: string): Promise<RevalidateOutcome> {
  const detail = await deps.persistence.getOrderForReview(orderId);
  if (!detail) return { status: "NOT_FOUND" };
  if (detail.header.rowVersion !== expectedRowVersion) return { status: "CONFLICT", rowVersion: detail.header.rowVersion };
  if (!REVALIDATABLE.has(detail.header.internalState)) return { status: "INVALID_STATE", internalState: detail.header.internalState };

  // Rebuild the normalized order from the corrected columns (overlaid on the stored extraction).
  const po = reconstructNormalized(detail);
  const findings = await evaluateOrder(po, deps.masters);

  const blocking = findings.some((f) => f.blocking);
  const internalState = blocking ? "NEEDS_REVIEW" : "READY";
  const write: RevalidationWrite = {
    findings: toValidationWrites(findings),
    internalState,
    simpleStatus: toSimpleStatus(internalState as InternalState),
    erpCustomerAccount: po.header.customer?.erp_customer_account?.value ?? null,
    lines: detail.lines.map((l, i) => ({ lineId: l.lineId, erpItemId: po.lines[i]?.erp_item_id?.value ?? l.erpItemId })),
  };

  const result = await deps.persistence.applyRevalidation(orderId, expectedRowVersion, write, actor);
  if (result.status === "OK") return { status: "OK", rowVersion: result.rowVersion, internalState, findings };
  return result;
}

function setField<T>(existing: Field<T> | undefined, value: T): Field<T> {
  return { ...(existing ?? {}), value };
}

/** Overlay the CSR-corrected header/line columns onto the stored normalized PO (source of truth for names/totals). */
function reconstructNormalized(detail: OrderReviewDetail): NormalizedPurchaseOrder {
  const h = detail.header;
  const base: NormalizedPurchaseOrder =
    detail.normalized && typeof detail.normalized === "object"
      ? (structuredClone(detail.normalized) as NormalizedPurchaseOrder)
      : ({ company: { company_id: h.companyId }, extraction: { overall_confidence: 1 }, header: {}, lines: [] } as unknown as NormalizedPurchaseOrder);

  base.company = { ...(base.company ?? {}), company_id: h.companyId };
  base.header.customer_po_number = setField(base.header.customer_po_number, h.customerPoNumber);
  base.header.normalized_po_number = h.normalizedPoNumber;
  base.header.po_date = setField(base.header.po_date, h.poDate);
  base.header.currency = setField(base.header.currency, h.currency);
  base.header.ship_to = setField(base.header.ship_to, h.shipTo);
  base.header.bill_to = setField(base.header.bill_to, h.billTo);
  base.header.customer = { ...(base.header.customer ?? {}), erp_customer_account: setField(base.header.customer?.erp_customer_account, h.erpCustomerAccount) };

  // Overlay corrected line columns by position (detail + normalized share ingest order).
  detail.lines.forEach((dl, i) => {
    const line = base.lines[i];
    if (!line) return;
    line.erp_item_id = setField(line.erp_item_id, dl.erpItemId);
    line.quantity = setField(line.quantity, dl.quantity);
    line.uom = setField(line.uom, dl.uom);
    line.unit_price = setField(line.unit_price, dl.unitPrice);
    line.extended_amount = setField(line.extended_amount, dl.extendedAmount);
  });

  return base;
}
