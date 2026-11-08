# 10 — Risks & Assumptions

Covers spec §18 (return risks and assumptions). Risks rated by Impact × Likelihood. Each links to the
open question or ADR that retires it.

## 10.1 Risk register

| ID | Risk | Impact | Likelihood | Mitigation / trigger |
|---|---|---|---|---|
| R-1 | Duplicate reaches AX via Email↔EDI race (fails #1 acceptance gate) | High | Med | ADR 0002 + Q-BOOMI-3/Q-AX-1; test both collision directions before Phase 5 sign-off |
| R-2 | Fabric Lakehouse can't do transactional staging/acks as needed | High | Med | ADR 0004 / Q-FAB-2; publisher behind an interface; evaluate Warehouse |
| R-3 | Boomi canonical 850 differs from assumptions → adapter rework | High | Med | Q-BOOMI-1 first; thin adapter seam; EDI regression suite |
| R-4 | Fabric master schema unknown → matching built on wrong fields | High | Med | Q-FAB-1; "do not invent fields"; read model built from real export |
| R-5 | AI mis-extraction with high confidence stages bad order | High | Low | ADR 0005: blocking checks independent of confidence; never invent IDs |
| R-6 | Learned pattern drift/poisoning bypasses validation | Med | Low | CANDIDATE→TRUSTED gating + master revalidation + kill-switch (§10) |
| R-7 | Graph throttling / missed notifications lose orders | Med | Med | Delta reconciliation + retries/backoff + renewal (§4) |
| R-8 | PII exposure in logs/documents | High | Low | PII redaction, private endpoints, RBAC, retention (§3, threat model) |
| R-9 | Org stack standard ≠ proposed TS → scaffolding redo | Low | Med | ADR 0006; all contracts stack-neutral; confirm Q-ENV-3 before Phase 1 |
| R-10 | Scope creep into out-of-scope items (multi-tenant, AP invoices, direct AX) | Med | Med | Enforce §1 non-goals; module_code seam ≠ tenancy |
| R-11 | Production safety breach (dev writes to real mailbox/AX) | High | Low | Separate RGs/identities; no prod writes in dev; mocks test-only (§3, §18) |
| R-12 | Missing PO sample diversity → poor extraction on real docs | Med | Med | Obtain scanned/rotated/multi-order samples in Phase 0 (§16) |

## 10.2 Assumptions (to confirm)

1. Exactly **one M365 mailbox** (shared or dedicated) is the intake channel for this release (§4).
2. **Boomi remains the sole AX writer**; we only write Fabric staging — no direct AX connector (§1).
3. **One enterprise, multiple legal entities** (`dataAreaId`); this is company partitioning, **not**
   multi-tenant SaaS (§7, §10).
4. Fabric exposes a **supported SQL endpoint/API** for master reads via managed identity or approved SP
   (§6) — to confirm (Q-FAB-3).
5. The existing **EDI 850 pipeline is live and must not regress**; shared duplicate controls span both
   channels (§11).
6. **Pricing may be optional**; validation policy + tolerances are configurable, not hard-coded
   (§1, §7) — to confirm (Q-VAL-1/Q-PRICE-1).
7. **No production ERP writes / mailbox mutations during development**; mocks/flags for test envs only,
   clearly labelled (§3, §18).
8. Reviewers operate a **human-in-the-loop** model; auto-stage thresholds are configurable and default
   conservative (§10).
9. Retention, RPO/RTO, availability, and accuracy **SLOs are agreed before production sign-off** (§16) —
   open (Q-ENV-1).
10. **Proposed stack = TypeScript**; may change to .NET/Python per org standard without altering the
    documented contracts/data model (ADR 0006).

## 10.3 Non-goals reaffirmed (§1)
No multi-tenant SaaS, no AP invoice processing, no direct AX connector, no new EDI translator, no
from-scratch model training, no uncontrolled order changes after AX creation.
