/**
 * Maps the domain NormalizedPurchaseOrder (docs/04) + the pipeline decision onto the flat
 * persistence write shapes. Kept separate from both the pipeline and the storage adapters so
 * the row mapping has one home and one test.
 */
import type { NormalizedPurchaseOrder, ValidationFinding } from "@coa/po-schema";
import type {
  OrderHeaderWrite,
  OrderLineWrite,
  StatusHistoryWrite,
  ValidationWrite,
} from "./ports.js";

export function toOrderHeaderWrite(
  po: NormalizedPurchaseOrder,
  decision: { simpleStatus: string; internalState: string; sourceChannel?: string },
): OrderHeaderWrite {
  const h = po.header;
  return {
    sourceChannel: decision.sourceChannel ?? "EMAIL_PO",
    erpCustomerAccount: h.customer?.erp_customer_account?.value ?? null,
    customerPoNumber: h.customer_po_number?.value ?? null,
    normalizedPoNumber: h.normalized_po_number ?? null,
    poDate: h.po_date?.value ?? null,
    requestedDeliveryDate: h.requested_delivery_date?.value ?? null,
    shipTo: h.ship_to?.value ?? null,
    billTo: h.bill_to?.value ?? null,
    currency: h.currency?.value ?? null,
    total: h.totals?.grand_total?.amount ?? null,
    lineCount: po.lines.length,
    simpleStatus: decision.simpleStatus,
    internalState: decision.internalState,
  };
}

export function toOrderLineWrites(po: NormalizedPurchaseOrder): OrderLineWrite[] {
  return po.lines.map((l) => ({
    sourceLineNo: l.source_line_no ?? null,
    customerItemCode: l.customer_item_code?.value ?? null,
    erpItemId: l.erp_item_id?.value ?? null,
    quantity: l.quantity?.value ?? null,
    uom: l.uom?.value ?? null,
    unitPrice: l.unit_price?.value ?? null,
    extendedAmount: l.extended_amount?.value ?? null,
    requestedDate: l.requested_date?.value ?? null,
    evidenceJson: l.description?.evidence ? JSON.stringify({ description: l.description.evidence }) : null,
  }));
}

export function toValidationWrites(findings: ValidationFinding[]): ValidationWrite[] {
  return findings.map((f) => ({
    severity: f.severity,
    code: f.code,
    fieldPath: f.field_path ?? null,
    message: f.message ?? null,
    blocking: f.blocking,
  }));
}

export function toStatusHistoryWrite(internalState: string): StatusHistoryWrite {
  return { fromState: "VALIDATING", toState: internalState, actor: "system", reason: null };
}
