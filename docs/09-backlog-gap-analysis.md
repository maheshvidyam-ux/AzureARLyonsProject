# 09 — Phased Backlog & Gap Analysis

Covers spec §17 (phased backlog) + §18 (per-phase deliverables). Each phase ships as **tested vertical
slices** with migrations, updated OpenAPI, Terraform/config, a runbook, sample payloads, evidence of
passing tests, and known limitations (§18). No phase deploys to production infra, mailbox, or AX without
approval.

## 9.1 Gap analysis (what's missing before we can build)

| Gap | Impact | Resolution |
|---|---|---|
| **Not a git repo; only the spec PDF present** | No history, no CI | ✅ `git init` done (this session); add remote (pending — see below) |
| **Existing AP Automation patterns absent locally** | Lose intended design-inspiration reuse | Obtain repo/docs (Q, Phase 0) |
| **Existing Boomi EDI 850 implementation absent locally** | AX integration baseline unknown → Phase 5 blocked | Obtain maps + process map (Q-BOOMI-1) |
| **No Fabric schemas** | Matching + read model cannot be built accurately | Q-FAB-1 |
| **No PO sample set** | Extraction + test matrix (§16) cannot be exercised | Q, Phase 0 |
| **Cross-channel idempotency with Boomi/AX undefined** | Duplicate could still reach AX (fails #1 gate) | Q-BOOMI-3, Q-AX-1 |
| **Fabric write path undecided** | Publisher design blocked | Q-FAB-2 / ADR 0004 |
| **Stack/hosting standards unconfirmed** | Scaffolding choice may be redone | Q-ENV-1/2/3 / ADR 0006 |

## 9.2 Backlog by phase (with vertical slices & exit criteria)

### Phase 0 — Discovery  *(current)*
- Obtain: Boomi canonical 850 + process map, AX dup-check approach, Fabric schemas, mailbox permissions,
  PO samples, legal entities, validation policy, hosting/security standards.
- **Deliverables:** this planning package + ADRs + gap analysis (done); answers to `07-contract-questions.md`.
- **Exit:** all §1/§11/§17 "decisions to verify" answered & reviewed; stack/hosting confirmed.

### Phase 1 — Foundation
- Slices: repo scaffolding + CI/CD; Terraform (dev) for Container Apps/PG/Service Bus/Blob/Key
  Vault/ACR/Monitor; Entra auth + app roles; PG migrations baseline; app shell; `GET /health`,
  `GET /metrics`; audit event plumbing.
- **Exit:** authenticated empty app deploys to **dev**; migrations run+rollback; health green; RBAC smoke test.

### Phase 2 — Intake & extraction
- Slices: Graph ingestion (webhook + validation + delta reconcile + renewal); attachment→Blob; idempotent
  ingestion record; classifier; Document Intelligence + evidence capture; AI Foundry schema-constrained
  interpretation (versioned prompts, cost tracking); status machine; exception handling.
- **Exit:** a sample email PO becomes a normalized PO (doc 04) with evidence; replay/retry creates no
  duplicate record; DI/AI failures degrade to `Failed`/review.

### Phase 3 — Master matching & duplicates
- Slices: Fabric read model (freshness/health visible); customer matching (ranked, evidence); item
  matching (SKU/customer-map/GTIN/pack-UOM, no desc-only auto-match); UOM/qty/price validation;
  **atomic duplicate claim**; cross-channel ERP/EDI dup lookup; rules + tests.
- **Exit:** concurrent duplicate arrival → exactly one claim wins (test); email/EDI collision blocked both
  directions; stale master data → controlled exception.

### Phase 4 — Review UX
- Slices: queue (filter/SLA/confidence); two-pane PDF viewer with bounding-box highlight +
  source-to-field; editable header/lines with optimistic concurrency; revalidate; approve/reject;
  duplicate comparison; activity timeline; role enforcement; accessibility (no color-only status).
- **Exit:** reviewer corrects a wrong customer via PDF highlight and approves; edits never lost; §14 UX
  acceptance met.

### Phase 5 — Boomi integration
- Slices: choose Fabric staging target (ADR 0004); transactional outbox + retryable publisher +
  reconciliation; thin canonical adapter reusing Boomi maps; Boomi consumption + AX acks via
  `/integration/acknowledgments`; **EDI regression suite**.
- **Exit:** approved order → staging → Boomi → AX SO id captured; partial publish/Boomi retry/AX timeout
  recover with no duplicate side effects; **existing EDI 850 regression passes**.

### Phase 6 — Learning
- Slices: learning event store; first-correction candidate rule + relative-coordinate reuse on next
  similar template; customer/item alias mappings (conflict/recency guarded); pattern admin + explainability;
  learning dashboard (accuracy/STP/drift).
- **Exit:** **at least one learned template reuses a correction on a later PO** (acceptance gate, §16);
  stale learned mapping cannot bypass Fabric validation.

### Phase 7 — Hardening
- Performance/SLO validation, security review, DR tests, monitoring dashboards, UAT, runbooks, pilot,
  production rollout, hypercare.
- **Exit:** nonfunctional SLOs (Q-ENV-1) met; RBAC+audit verified; DR restore tested.

### Phase 8 — Optional specialized local model
- Dataset generator from approved/AX-posted outcomes; lightweight ML eval; Azure-hosted small OSS model;
  **shadow mode**; fine-tuning assessment (LoRA/QLoRA on approved data only); registry; controlled
  promotion + rollback; quantized inference.
- **Exit:** shadow metrics beat baseline before any promotion; never trained from scratch or on unverified
  corrections.

## 9.3 First implementable slice (once Phase 0 unblocks)
**"Ingest one sample PO end-to-no-stage":** Graph mock → durable record (idempotent) → Blob → DI → Foundry
→ normalized PO (doc 04) → validation findings → **stop before staging**. Proves the spine with mocks,
touches nothing external, and exercises the §16 "clean single PO" + "AI malformed JSON" cases.

## 9.4 Acceptance gate traceability (§16)
Every item below maps to a phase exit criterion above: no invalid/duplicate order reaches AX (P3/P5);
end-to-end traceable (P1–P5); EDI regression passes (P5); review UX highlighting+correction (P4); learned
template reuse (P6); failure recovery without duplicate side effects (P2/P3/P5); RBAC + audit verified
(P1/P7).
