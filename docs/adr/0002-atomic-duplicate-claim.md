# ADR 0002 — Atomic cross-channel duplicate claim in PostgreSQL

**Status:** Accepted (spec §8); key composition blocked by Q-DUP-1/2

## Context
Orders can arrive by Email **and** EDI, and multiple email workers run concurrently. The #1 acceptance
gate is "no duplicate order reaches AX" (§16).

## Decision
- Business key = `normalized_po_number + erp_customer_account + company_id` (legal entity).
- Enforce with a **unique partial index** on `duplicate_claim(business_key) WHERE status IN
  ('CLAIMED','RESOLVED')`. The insert of the claim is the atomic gate; exactly one concurrent worker wins.
- The claim happens **before** staging. Losers route to `DUPLICATE_REVIEW` with side-by-side comparison.
- Cross-channel: coordinate with Boomi/AX idempotency so EDI and Email cannot both create the same AX SO
  (Q-BOOMI-3, Q-AX-1). Check both `email→EDI` and `EDI→email` collision paths.
- Resolution of a blocked duplicate is **policy-gated supervisor action**, fully audited; original claim
  history retained.

## Consequences
- Normalization rule (Q-DUP-1) and revision/release/blanket handling (Q-DUP-2) must be fixed before the
  key is finalized — a wrong key either lets duplicates through or blocks legitimate revisions.
- Requires an authoritative AX/EDI "does this order already exist?" feed or query (Q-AX-1).
