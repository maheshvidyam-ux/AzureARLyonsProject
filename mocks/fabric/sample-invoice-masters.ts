/**
 * TEST-ENV-ONLY AP master data (spec §18 — quarantined). Vendors + open PO lines + goods
 * receipts so `sample-inv-po-001` matches cleanly (3-way) and the non-PO sample matches a vendor.
 * ⚠️ Placeholder fields — real Lakehouse tables are Q-FAB-1 (gold.ax_vendmaster etc).
 */
import type { GoodsReceipt, PoLine, VendorMaster } from "@coa/fabric-read";

export const SAMPLE_VENDORS: VendorMaster[] = [
  { erpVendorAccount: "VEND-ACME", companyId: "USMF", name: "Acme Industrial Supply", taxId: "12-3456789", aliases: ["Acme Ind."], status: "ACTIVE" },
  { erpVendorAccount: "VEND-GLOBEX", companyId: "USMF", name: "Globex Corporation", status: "ACTIVE" },
];

export const SAMPLE_PO_LINES: PoLine[] = [
  { companyId: "USMF", poNumber: "PO-100045", poLineRef: "1", erpItemId: "ITM-778", erpVendorAccount: "VEND-ACME", orderedQty: 500, unitPrice: 1.5, uom: "EA" },
  { companyId: "USMF", poNumber: "PO-100045", poLineRef: "2", erpItemId: "ITM-902", erpVendorAccount: "VEND-ACME", orderedQty: 1000, unitPrice: 0.5, uom: "EA" },
];

export const SAMPLE_RECEIPTS: GoodsReceipt[] = [
  { companyId: "USMF", poNumber: "PO-100045", poLineRef: "1", receivedQty: 500 },
  { companyId: "USMF", poNumber: "PO-100045", poLineRef: "2", receivedQty: 1000 },
];
