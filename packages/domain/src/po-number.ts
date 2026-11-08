/**
 * PO-number normalization (spec §8 / Q-DUP-1).
 *
 * ⚠️ PROVISIONAL RULE — the authoritative canonicalization (case, punctuation, leading
 * zeros, prefixes) is a Phase-0 business decision still OPEN as Q-DUP-1 in
 * docs/07-contract-questions.md. This implementation is deliberately conservative and is
 * used only to produce `normalized_po_number`, which is the first component of the atomic
 * duplicate business key. It MUST be revisited before the Phase-3 duplicate-claim slice.
 *
 * Current provisional behaviour:
 *   - trim surrounding whitespace
 *   - uppercase
 *   - collapse internal whitespace runs to nothing
 *   - strip characters that are not A-Z or 0-9
 * Leading zeros are intentionally PRESERVED (stripping them is a known ambiguity pending
 * the business answer).
 */
export function normalizePoNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The duplicate business key (spec §8, docs/03 §Consistency & keys):
 *   normalized_po_number + erp_customer_account + company_id
 * Returned here as a stable string for logging/record-keeping. The *atomic* claim itself
 * is a Phase-3 PostgreSQL unique-index concern and is NOT performed in this slice.
 */
export function duplicateBusinessKey(input: {
  normalizedPoNumber: string | null;
  erpCustomerAccount: string | null;
  companyId: string;
}): string | null {
  const { normalizedPoNumber, erpCustomerAccount, companyId } = input;
  if (!normalizedPoNumber || !erpCustomerAccount) return null;
  return `${companyId}::${erpCustomerAccount}::${normalizedPoNumber}`;
}
