/**
 * Vendor matching for AP invoices (AP_INVOICE). Ranked, ambiguity-aware (a tie → UNMATCHED, no
 * guess): TAX_ID → EXACT name → ALIAS → FUZZY. Never invents an ERP vendor account.
 */
import type { VendorMaster } from "@coa/fabric-read";
import type { VendorMatchStatus } from "@coa/invoice-schema";
import { normalizeCode, normalizeText, tokenSimilarity } from "./text.js";

export interface VendorQuery {
  name: string | null;
  taxId?: string | null;
}
export interface VendorMatchResult {
  erpVendorAccount: string | null;
  matchStatus: VendorMatchStatus;
  confidence: number;
  evidence: string;
  ambiguous: boolean;
}

const FUZZY_THRESHOLD = 0.6;
const unmatched = (evidence: string, ambiguous = false): VendorMatchResult => ({ erpVendorAccount: null, matchStatus: "UNMATCHED", confidence: 0, evidence, ambiguous });
const ok = (v: VendorMaster, matchStatus: VendorMatchStatus, confidence: number, evidence: string): VendorMatchResult => ({ erpVendorAccount: v.erpVendorAccount, matchStatus, confidence, evidence, ambiguous: false });

export function matchVendor(query: VendorQuery, candidates: VendorMaster[]): VendorMatchResult {
  const name = normalizeText(query.name);
  const taxId = normalizeCode(query.taxId);

  if (taxId) {
    const hit = candidates.filter((v) => normalizeCode(v.taxId) === taxId);
    if (hit.length === 1) return ok(hit[0]!, "TAX_ID", 0.99, `tax id match`);
    if (hit.length > 1) return unmatched("ambiguous tax id", true);
  }
  if (name) {
    const exact = candidates.filter((v) => normalizeText(v.name) === name);
    if (exact.length === 1) return ok(exact[0]!, "EXACT", 0.98, `exact name '${query.name}'`);
    if (exact.length > 1) return unmatched(`ambiguous exact name '${query.name}'`, true);

    const alias = candidates.filter((v) => (v.aliases ?? []).some((a) => normalizeText(a) === name));
    if (alias.length === 1) return ok(alias[0]!, "ALIAS", 0.9, `alias match '${query.name}'`);
    if (alias.length > 1) return unmatched(`ambiguous alias '${query.name}'`, true);

    const scored = candidates.map((v) => ({ v, s: tokenSimilarity(query.name ?? "", v.name) })).filter((x) => x.s >= FUZZY_THRESHOLD).sort((a, b) => b.s - a.s);
    if (scored.length === 1 || (scored.length > 1 && scored[0]!.s - scored[1]!.s >= 0.15)) {
      return ok(scored[0]!.v, "FUZZY", Number(scored[0]!.s.toFixed(2)), `fuzzy name (${scored[0]!.s.toFixed(2)})`);
    }
    if (scored.length > 1) return unmatched("ambiguous fuzzy name", true);
  }
  return unmatched("no vendor match");
}
