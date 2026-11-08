# Session Log — 2026-11-08

A record of the working session that implemented Phase 1 (foundation) and the first Phase 2 slices
(intake & extraction), including the key decisions and the verifications run against real Azure.

## Conversation flow (what was asked → what was done)

1. **"check the next steps"** — Reviewed the Phase-0 planning package. Reported that Phase 0 was
   complete and the first implementable slice (backlog §9.3, fully mocked) could start immediately;
   most other work was gated on open contract questions.
2. **"start coding the project"** — Built the first vertical slice **"Ingest one PO end-to-no-stage"**
   in TypeScript (ADR 0006): `@coa/po-schema`, `@coa/domain`, the worker pipeline (ingest → Document
   Intelligence → AI Foundry → normalize → deterministic validation → stop before staging), quarantined
   mocks, and e2e tests for the §16 cases (clean / review / malformed) + idempotency.
3. **"for UI the backend sql database can be in fabric itself" / "we can create a sql server in fabric"**
   — Raised **ADR 0007**: evaluated SQL database in Fabric vs Azure PostgreSQL as the operational store.
4. **Decision: "Adopt Fabric SQL now"** — Superseded ADR 0001; updated invariant wording across the
   docs; authored the baseline T-SQL migration (`db/migrations/0001`) including the atomic
   duplicate-claim filtered unique index. Noted the availability-coupling trade as a prod gate.
5. **"build the persistence Fabric SQL adapter next"** — Built `@coa/persistence`: an engine-neutral
   `Persistence` port with an in-memory impl (tests) and a real **mssql** SQL-database-in-Fabric adapter
   + migration runner. Rewired the pipeline to persist through the port; all writes idempotent.
6. **"wire up the CI/CD pipeline next"** — GitHub Actions: `ci.yml` (typecheck, lint [ESLint], migration
   pairing check, tests, prod-dep audit, `terraform validate`) and `infra-plan.yml` (OIDC
   `terraform plan`, skips when unconfigured). Built the Phase-1 Terraform foundation beforehand
   (Fabric SQL + Container Apps + Service Bus + Key Vault + ACR + Blob + Monitor + identities + network);
   `terraform validate` clean.
7. **Provisioned a dev Fabric SQL database** — User created the DB and shared its connection string.
   Added `@azure/identity`; ran migration `0001` against the **real** database and verified all tables +
   the duplicate-claim index via `scripts/verify-fabric-schema.mts`.
8. **"build the ingestion worker" / Phase 2** — Built the Microsoft Graph ingestion adapter
   (`GraphApiClient` seam, `HttpGraphApiClient`, `GraphMailboxSource` with delta sweep, notifications,
   subscriptions), the **apps/api Fastify webhook**, the **ingestion worker**, and the **Azure Service
   Bus adapter** (`@coa/messaging`, peek-lock retry/DLQ). Closed the webhook → queue → worker → pipeline
   → persist loop.
9. **Live capstone** — Ran the full loop against the real Fabric SQL database (webhook → queue → worker →
   persisted 2 orders → read back → cleaned up), leaving the DB schema-only. `scripts/capstone-fabric.mts`.
10. **"commit this Phase-2 work to git" + "save the conversation"** — This commit + this log.

## Key decisions

- **ADR 0006** — TypeScript stack (Node + Fastify, npm workspaces) — proposed default, confirmed in use.
- **ADR 0007** — Operational source of truth = **SQL database in Fabric** (transactional OLTP), superseding
  ADR 0001's PostgreSQL. Mandatory prod follow-ups: capacity no-pause/reserved policy (availability
  coupling), concurrency proof of the duplicate claim, RPO/RTO confirmation.
- CI/CD platform = **GitHub Actions** (provisional; Q-ENV-2 still open).

## Verified against real infrastructure

- Migration `0001` applied to the dev Fabric SQL database; schema + filtered unique index confirmed.
- Full Phase-2 loop (webhook → Service Bus-shaped queue → worker → pipeline → Fabric SQL) ran end to end
  with read-back and cleanup.
- Test suite at session end: **35 passing, 2 skipped** (the 2 skipped are the live Fabric SQL and live
  Service Bus round-trips, gated behind env vars). Typecheck + lint clean.

## Still gated / next

- Non-code gate: **Graph `Mail.Read`** app permission scoped to the mailbox (Q-GRAPH-1).
- Next slices: DB-backed `DeltaStore` + reconciliation sweeper; real Document Intelligence + AI Foundry
  clients + classifier (then a runnable worker entrypoint); Entra OIDC on reviewer/admin API routes.
- Later phases: review UX (4), Boomi/AX publish (5), learning (6), hardening (7).

> This is a human-authored summary of the session, not a verbatim transcript.
