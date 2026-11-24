/**
 * Resolve the purchase order an AP invoice is billing against, tolerant of the vendor dropping the
 * "PO-" prefix. Strategy (as specified by the business):
 *   1. Match the VENDOR first, then search THAT vendor's POs for the invoice's (canonical) PO number.
 *   2. If the vendor is not resolved, look the PO number up across the PO table; a PO found that way
 *      identifies its own vendor, which we then adopt.
 * Returns the resolved PO's lines + real PO number + the (possibly PO-derived) vendor account, so the
 * caller can run the 3-way match and backfill the vendor.
 */
import { canonicalPoNumber } from "@coa/domain";
import type { InvoiceMasterReader, PoLine } from "@coa/fabric-read";

export type PoResolutionVia = "vendor_po" | "po_lookup" | "none";

export interface PoResolution {
  /** The master PO number (e.g. "PO-100045"), or null if no PO matched. */
  poNumber: string | null;
  /** ERP vendor account — the matched vendor, or one derived from the looked-up PO. */
  erpVendorAccount: string | null;
  /** The resolved PO's lines (for the 3-way match). */
  poLines: PoLine[];
  via: PoResolutionVia;
}

export async function resolvePurchaseOrder(
  masters: InvoiceMasterReader,
  input: { companyId: string; erpVendorAccount: string | null; poNumberRaw: string | null },
): Promise<PoResolution> {
  const canon = canonicalPoNumber(input.poNumberRaw);
  if (!canon) return { poNumber: null, erpVendorAccount: input.erpVendorAccount, poLines: [], via: "none" };

  // 1. Vendor matched → search ONLY that vendor's POs (prefix-tolerant). We never silently switch a
  //    matched vendor to another vendor's PO: if its POs don't contain this number, that's a mismatch.
  if (input.erpVendorAccount) {
    const vendorPos = await masters.findPoLinesForVendor(input.companyId, input.erpVendorAccount);
    const matched = vendorPos.filter((l) => canonicalPoNumber(l.poNumber) === canon);
    if (matched.length > 0) {
      return { poNumber: matched[0]!.poNumber, erpVendorAccount: input.erpVendorAccount, poLines: matched, via: "vendor_po" };
    }
    return { poNumber: null, erpVendorAccount: input.erpVendorAccount, poLines: [], via: "none" };
  }

  // 2. Vendor unmatched → look the PO number up across vendors; adopt the PO's vendor if unambiguous.
  const byPo = await masters.findPoLinesByPoNumber(input.companyId, canon);
  if (byPo.length > 0) {
    const vendorAccounts = new Set(byPo.map((l) => l.erpVendorAccount));
    const derivedVendor = vendorAccounts.size === 1 ? byPo[0]!.erpVendorAccount : null;
    return { poNumber: byPo[0]!.poNumber, erpVendorAccount: derivedVendor, poLines: byPo, via: "po_lookup" };
  }

  return { poNumber: null, erpVendorAccount: null, poLines: [], via: "none" };
}
