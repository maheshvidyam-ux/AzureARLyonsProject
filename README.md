# AzureARAP — Order & AP Invoice Automation (Lyons)

Azure-native platform that automates two document-driven finance processes on **one** shared pipeline
(Microsoft 365 email → Azure AI Document Intelligence + AI Foundry → validate against Microsoft Fabric
masters → resolve exceptions in a reviewer UI → publish to Fabric staging for the **existing** Boomi
subprocess that posts to Dynamics AX 2012 — learning from every correction):

- **AR · Order Processing** (`ORDER_PROCESSING`) — customer purchase orders → AX **sales orders**;
  duplicates blocked across Email **and** EDI (atomic claim).
- **AP · Invoice Processing** (`AP_INVOICE`) — vendor invoices → AX **vendor invoices / AP vouchers**;
  PO / receipt matching (2-way/3-way), duplicate-invoice prevention.

The two run as separate **modules** (spec §10 `module_code` seam) sharing ingestion, extraction, the
reviewer workbench, persistence (SQL database in Fabric), Service Bus, and Boomi staging — differing only
in schema, matching/validation rules, and the AX target. See **[ADR 0008](docs/adr/0008-ap-invoice-module.md)**.

> Spec: `Customer_Order_Automation_Azure_Implementation_Specification.pdf` (v1.0, Nov 2026). AP invoice
> automation is an additional module on the same architecture (its own spec/§ references TBD).

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
