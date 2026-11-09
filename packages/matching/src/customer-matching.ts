/**
 * Customer matching against Fabric masters (spec §6). Ranked, evidence-bearing, and
 * ambiguity-aware: a tie at a strategy yields UNMATCHED (route to review) rather than a guess —
 * AI/heuristics never invent an ERP account. CROSS_REF and ALIAS are checked before weaker
 * name/address signals; FUZZY only accepts a single clear winner above threshold.
 *
 * Deferred (flagged): HISTORY matching (learned aliases — Phase 6) and tuning of the fuzzy
 * threshold against real data (Q-VAL-1).
 */
import type { CustomerMaster } from "@coa/fabric-read";
import type { CustomerMatchStatus } from "@coa/po-schema";
import { normalizeCode, normalizeText, tokenSimilarity } from "./text.js";

export interface CustomerQuery {
  name: string | null;
  billTo?: string | null;
  shipTo?: string | null;
  /** A buyer/account code lifted from the PO, if any (feeds CROSS_REF). */
  accountRef?: string | null;
}

export interface CustomerMatchResult {
  erpCustomerAccount: string | null;
  matchStatus: CustomerMatchStatus;
  confidence: number;
  evidence: string;
  /** true when multiple masters tied at the winning strategy — forces review, no account set. */
  ambiguous: boolean;
}

const FUZZY_THRESHOLD = 0.6;

const unmatched = (evidence: string, ambiguous = false): CustomerMatchResult => ({
  erpCustomerAccount: null,
  matchStatus: "UNMATCHED",
  confidence: 0,
  evidence,
  ambiguous,
});

export function matchCustomer(query: CustomerQuery, candidates: CustomerMaster[]): CustomerMatchResult {
  const name = normalizeText(query.name);
  const accountRef = normalizeCode(query.accountRef);
  const addresses = [query.billTo, query.shipTo].map(normalizeText).filter(Boolean);

  // 1. CROSS_REF — an explicit buyer/account code on the PO.
  if (accountRef) {
    const hit = candidates.filter((c) => (c.crossRefs ?? []).some((r) => normalizeCode(r) === accountRef));
    if (hit.length === 1) return ok(hit[0]!, "CROSS_REF", 0.97, `accountRef '${query.accountRef}' matched cross-reference`);
    if (hit.length > 1) return unmatched(`ambiguous CROSS_REF for '${query.accountRef}'`, true);
  }

  // 2. EXACT — normalized name equality.
  if (name) {
    const hit = candidates.filter((c) => normalizeText(c.name) === name);
    if (hit.length === 1) return ok(hit[0]!, "EXACT", 0.99, `exact name match '${query.name}'`);
    if (hit.length > 1) return unmatched(`ambiguous exact name '${query.name}'`, true);
  }

  // 3. ALIAS — name among the master's known aliases.
  if (name) {
    const hit = candidates.filter((c) => (c.aliases ?? []).some((a) => normalizeText(a) === name));
    if (hit.length === 1) return ok(hit[0]!, "ALIAS", 0.9, `alias match '${query.name}'`);
    if (hit.length > 1) return unmatched(`ambiguous alias '${query.name}'`, true);
  }

  // 4. ADDRESS — a bill-to/ship-to line matches a master address.
  if (addresses.length > 0) {
    const hit = candidates.filter((c) =>
      (c.addresses ?? []).some((addr) => addresses.some((a) => a === normalizeText(addr))),
    );
    if (hit.length === 1) return ok(hit[0]!, "ADDRESS", 0.8, "address match");
    if (hit.length > 1) return unmatched("ambiguous address match", true);
  }

  // 5. FUZZY — single clear winner above threshold.
  if (name) {
    const scored = candidates
      .map((c) => ({ c, s: tokenSimilarity(query.name ?? "", c.name) }))
      .filter((x) => x.s >= FUZZY_THRESHOLD)
      .sort((a, b) => b.s - a.s);
    if (scored.length === 1 || (scored.length > 1 && scored[0]!.s - scored[1]!.s >= 0.15)) {
      return ok(scored[0]!.c, "FUZZY", Number(scored[0]!.s.toFixed(2)), `fuzzy name match (${scored[0]!.s.toFixed(2)})`);
    }
    if (scored.length > 1) return unmatched("ambiguous fuzzy name match", true);
  }

  return unmatched("no customer match");
}

function ok(c: CustomerMaster, matchStatus: CustomerMatchStatus, confidence: number, evidence: string): CustomerMatchResult {
  return { erpCustomerAccount: c.erpCustomerAccount, matchStatus, confidence, evidence, ambiguous: false };
}
