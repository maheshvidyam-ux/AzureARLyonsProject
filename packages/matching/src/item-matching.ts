/**
 * Item matching against Fabric masters (spec §6). Strong signals only — EXACT SKU, per-customer
 * code map, GTIN. **Never** auto-match on description alone (spec §6): a description-only
 * resemblance yields UNMATCHED (reviewer decides).
 *
 * Deferred (flagged): PACK_UOM pack/unit conversion matching, and UOM/quantity/price validation
 * against the matched master (Q-VAL-1 / Q-PRICE-1).
 */
import type { ItemMaster } from "@coa/fabric-read";
import type { LineMatchStatus } from "@coa/po-schema";
import { normalizeCode } from "./text.js";

export interface ItemQuery {
  customerItemCode: string | null;
  description?: string | null;
  gtin?: string | null;
}

export interface ItemMatchResult {
  erpItemId: string | null;
  matchStatus: LineMatchStatus;
  confidence: number;
  evidence: string;
}

const unmatched = (evidence: string): ItemMatchResult => ({ erpItemId: null, matchStatus: "UNMATCHED", confidence: 0, evidence });

export function matchItem(query: ItemQuery, candidates: ItemMaster[], erpCustomerAccount: string | null): ItemMatchResult {
  const code = normalizeCode(query.customerItemCode);
  const gtin = normalizeCode(query.gtin);

  // 1. EXACT_SKU
  if (code) {
    const hit = candidates.filter((i) => normalizeCode(i.sku) === code);
    if (hit.length === 1) return ok(hit[0]!, "EXACT_SKU", 0.98, `exact SKU '${query.customerItemCode}'`);
    if (hit.length > 1) return unmatched(`ambiguous SKU '${query.customerItemCode}'`);
  }

  // 2. CUSTOMER_MAP — the customer's own code for this item.
  if (code && erpCustomerAccount) {
    const hit = candidates.filter((i) =>
      (i.customerItemCodes?.[erpCustomerAccount] ?? []).some((c) => normalizeCode(c) === code),
    );
    if (hit.length === 1) return ok(hit[0]!, "CUSTOMER_MAP", 0.95, `customer code map '${query.customerItemCode}'`);
    if (hit.length > 1) return unmatched(`ambiguous customer code '${query.customerItemCode}'`);
  }

  // 3. GTIN
  const gtinKey = gtin || code;
  if (gtinKey) {
    const hit = candidates.filter((i) => (i.gtins ?? []).some((g) => normalizeCode(g) === gtinKey));
    if (hit.length === 1) return ok(hit[0]!, "GTIN", 0.97, `GTIN '${gtinKey}'`);
    if (hit.length > 1) return unmatched(`ambiguous GTIN '${gtinKey}'`);
  }

  // Description-only resemblance never auto-matches.
  return unmatched("no strong item match (description-only never auto-matches)");
}

function ok(i: ItemMaster, matchStatus: LineMatchStatus, confidence: number, evidence: string): ItemMatchResult {
  return { erpItemId: i.erpItemId, matchStatus, confidence, evidence };
}
