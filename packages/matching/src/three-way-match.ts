/**
 * 3-way match for PO-based vendor invoices (AP_INVOICE): invoice line ↔ PO line ↔ goods receipt.
 * Confirms the invoiced quantity was actually received and the price matches the PO (within
 * tolerance). Variances are surfaced (not auto-approved) for reviewer resolution.
 */
import type { GoodsReceipt, PoLine } from "@coa/fabric-read";
import type { InvoiceLineMatchStatus } from "@coa/invoice-schema";
import { normalizeCode } from "./text.js";

const PRICE_TOLERANCE = 0.02; // 2% — provisional (Q-VAL-1 / Q-PRICE-1)

export interface InvoiceLineQuery {
  poLineRef: string | null;
  erpItemId?: string | null;
  quantity: number | null;
  unitPrice: number | null;
}
export interface ThreeWayResult {
  poLineRef: string | null;
  erpItemId: string | null;
  status: InvoiceLineMatchStatus;
  detail: string;
}

export function threeWayMatchLine(line: InvoiceLineQuery, poLines: PoLine[], receipts: GoodsReceipt[]): ThreeWayResult {
  const ref = normalizeCode(line.poLineRef);
  const item = normalizeCode(line.erpItemId);
  const po =
    (ref && poLines.find((l) => normalizeCode(l.poLineRef) === ref)) ||
    (item && poLines.find((l) => normalizeCode(l.erpItemId) === item)) ||
    undefined;

  if (!po) return { poLineRef: line.poLineRef, erpItemId: line.erpItemId ?? null, status: "NO_PO_LINE", detail: "no matching open PO line" };

  const receivedQty = receipts.filter((r) => normalizeCode(r.poLineRef) === normalizeCode(po.poLineRef)).reduce((s, r) => s + r.receivedQty, 0);
  const qty = line.quantity ?? 0;

  if (qty > receivedQty) {
    return { poLineRef: po.poLineRef, erpItemId: po.erpItemId, status: "OVER_RECEIPT", detail: `invoiced ${qty} > received ${receivedQty}` };
  }
  if (line.unitPrice != null && po.unitPrice > 0 && Math.abs(line.unitPrice - po.unitPrice) / po.unitPrice > PRICE_TOLERANCE) {
    return { poLineRef: po.poLineRef, erpItemId: po.erpItemId, status: "PRICE_VARIANCE", detail: `price ${line.unitPrice} vs PO ${po.unitPrice}` };
  }
  return { poLineRef: po.poLineRef, erpItemId: po.erpItemId, status: "PO_MATCHED", detail: `matched PO line ${po.poLineRef}, received ${receivedQty}` };
}
