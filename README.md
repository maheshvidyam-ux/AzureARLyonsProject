# Customer Order Automation

Azure-native platform that receives customer purchase orders by Microsoft 365 email, extracts them with
Azure AI Document Intelligence + AI Foundry, validates against Microsoft Fabric customer/item masters,
blocks duplicates across Email **and** EDI, resolves exceptions in a reviewer UI, and publishes approved
orders to Fabric staging for the **existing** Boomi EDI-850 subprocess that creates Dynamics AX 2012
sales orders — learning from every correction.

> Spec: `Customer_Order_Automation_Azure_Implementation_Specification.pdf` (v1.0, Nov 2026).

## Status

**Phase 0 complete; first Phase-1 vertical slice landed.** The planning package is in
**[`docs/00-first-response.md`](docs/00-first-response.md)** (architecture, repo tree, ERD, PO JSON
schema, API contracts, Azure resources, contract questions, threat model, backlog/gap analysis, risks,
ADRs).

The first implementable slice from backlog §9.3 — **"Ingest one PO end-to-no-stage"** — is now
implemented in TypeScript (ADR 0006) on fully **mocked** inputs and **stops before staging**:

```
Graph (mock) → idempotent ingestion record → Blob (mock) → Document Intelligence (recorded)
  → AI Foundry (recorded) → normalized PO (docs/04) → deterministic validation
  → READY | NEEDS_REVIEW | FAILED   ⟵ never stages, never touches anything external
```

```bash
npm install && npm run typecheck && npm run lint && npm test && npm run demo:slice
```

**CI/CD:** GitHub Actions (`.github/workflows/`) — `ci.yml` gates every PR (typecheck, lint, migration
check, tests, prod-dep audit, `terraform validate`); `infra-plan.yml` runs OIDC `terraform plan` on
infra PRs. See [`.github/workflows/README.md`](.github/workflows/README.md). **Infra:** Phase-1
Terraform foundation (SQL database in Fabric + Container Apps + supporting services) in
[`infra/terraform`](infra/terraform/README.md).

See the runbook: **[`docs/runbooks/first-slice.md`](docs/runbooks/first-slice.md)**. Remaining Phase-0
business/integration questions still gate the later phases —
[`docs/07-contract-questions.md`](docs/07-contract-questions.md).

## Guardrails (do not violate)
- Operational source of truth = **SQL database in Fabric** (transactional OLTP; ADR 0007, supersedes
  ADR 0001). Fabric Lakehouse/Warehouse = read masters + order staging; Boomi owns AX.
- No duplicate/invalid order may reach AX (atomic cross-channel claim).
- No production ERP writes, no production mailbox changes, no unreviewed infra deploys during development.

## Repo layout (planned)
See [`docs/02-repo-tree.md`](docs/02-repo-tree.md). Today the repo contains the spec and the `docs/`
planning package.
