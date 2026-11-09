# Runbook — Phase 3: Master Matching & Duplicates

Implements backlog Phase 3 (spec §6, §8). Delivers invariant #2 — **no duplicate order may ever reach
AX** — via customer/item matching against Fabric masters plus an **atomic cross-channel duplicate claim**.
Testable without real Fabric masters; the duplicate claim is proven against the real Fabric SQL database.

## Components

| Piece | Where | Role |
|---|---|---|
| Fabric read model | `@coa/fabric-read` | `MasterDataReader` port + in-memory reader + freshness/health. Real Fabric read adapter gated on **Q-FAB-1/Q-FAB-3** |
| Customer matching | `@coa/matching` | Ranked: CROSS_REF → EXACT → ALIAS → ADDRESS → FUZZY; ambiguity → UNMATCHED (no guess) |
| Item matching | `@coa/matching` | EXACT_SKU → CUSTOMER_MAP → GTIN; **description-only never auto-matches** |
| Atomic claim | `@coa/persistence` | `claimDuplicate` / `seedExternalClaim` / `markDuplicateReview` on the `duplicate_claim` filtered unique index |
| Pipeline wiring | `apps/workers/.../pipeline.ts` | match → form business key → claim → READY or DUPLICATE_REVIEW |

## Flow (added after validation)

```
validate → match customer+items (if read model wired)
  ├─ unmatched customer/item → blocking finding → NEEDS_REVIEW
  ├─ stale masters → MASTER_DATA_STALE (controlled exception) → NEEDS_REVIEW
  └─ matched & clean → persist → claimDuplicate(businessKey, EMAIL)
        ├─ CLAIMED   → READY (stop before staging)
        └─ COLLISION → markDuplicateReview → DUPLICATE_REVIEW
```

Business key = `normalized_po_number :: erp_customer_account :: company_id`. The claim is a single INSERT
guarded by the partial unique index `UX_duplicate_claim_active` (status IN CLAIMED/RESOLVED); exactly one
concurrent caller wins. Re-claiming by the **same** order is idempotent (no self-collision). External
EDI/AX claims are pre-registered with a NULL order (migration `0002`) so an Email PO collides with them.

## Tests

- `tests/e2e/matching.test.ts` — ranked strategies, ambiguity, no description-only item match.
- `tests/e2e/duplicate-claim.test.ts` — concurrency (one winner), cross-channel EDI block, idempotency.
- `tests/e2e/phase3-pipeline.test.ts` — matched PO claims → READY; second same-key PO → DUPLICATE_REVIEW;
  EDI cross-channel block; unmatched customer → NEEDS_REVIEW; stale masters → controlled exception.
- Live proof on real Fabric SQL: `npx tsx scripts/verify-duplicate-claim.mts` (self-cleaning).

## Deferred / gated

- Real Fabric masters read adapter — **Q-FAB-1** (schemas), **Q-FAB-3** (access pattern), **Q-FAB-4**
  (freshness SLA driving the stale threshold).
- HISTORY/learned-alias customer matching (Phase 6); PACK_UOM item matching; UOM/qty/**price** validation
  against the matched master (**Q-VAL-1 / Q-PRICE-1**).
- Cross-channel coordination with the real Boomi/AX feed — **Q-BOOMI-3 / Q-AX-1** (today EDI/AX claims are
  seeded; the live feed that registers them is Phase 5).
