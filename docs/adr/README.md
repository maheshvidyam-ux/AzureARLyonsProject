# Architecture Decision Records

Lightweight ADRs (one decision each). Status: `Proposed` until the relevant Phase-0 question
(`../07-contract-questions.md`) is answered and reviewed; then `Accepted`. Format: Context → Decision →
Consequences → Status.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-postgres-source-of-truth.md) | PostgreSQL is the operational source of truth; Fabric is read + staging | Accepted (from spec) |
| [0002](0002-atomic-duplicate-claim.md) | Atomic cross-channel duplicate claim in PostgreSQL | Accepted (from spec) |
| [0003](0003-transactional-outbox-publish.md) | Transactional outbox for Fabric staging publication | Accepted (from spec) |
| [0004](0004-fabric-staging-write-path.md) | Fabric staging write path (Lakehouse Delta vs Warehouse) | Proposed — blocked by Q-FAB-2 |
| [0005](0005-ai-suggests-rules-authorize.md) | AI suggests, deterministic rules authorize | Accepted (from spec) |
| [0006](0006-stack-and-hosting.md) | Backend stack = TypeScript; Azure Container Apps | Proposed — blocked by Q-ENV-1/3 |
