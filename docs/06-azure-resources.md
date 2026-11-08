# 06 — Azure Resource List

Covers spec §2 (deployment) and §15 (infrastructure). Provisioned via Terraform modules
(`infra/terraform/modules/*`), parameterized per environment (`infra/terraform/envs/{dev,test,prod}`).
**Separate resource groups and identity boundaries per environment.** Managed identities first; private
endpoints where supported; no secrets in code or state.

## 6.1 Resource inventory

| # | Resource | Azure service | Purpose | Notes / security |
|---|---|---|---|---|
| 1 | Container Apps Environment | Azure Container Apps | Hosts `web`, `api`, `workers` as independently scalable apps | VNet-integrated; scale-to-zero only for non-critical |
| 2 | Container Registry | Azure Container Registry (ACR) | Build/push app images | Managed-identity pull; no admin user |
| 3 | ~~PostgreSQL~~ **SQL database in Fabric** (ADR 0007) | Microsoft Fabric (Fabric capacity → workspace → SQL database) | Operational source of truth (§2) — transactional OLTP | Entra auth; auto-mirrors to OneLake; **no-pause capacity policy** required (ADR 0007 #1). Terraform: `modules/fabric-sqldb` |
| 4 | Service Bus | Azure Service Bus (Standard/Premium) | Durable queues/topics, DLQ, retry/backoff | Premium in prod for VNet + throughput |
| 5 | Blob Storage | Azure Storage (Blob) | Original documents + raw OCR payloads | Private endpoint; lifecycle/retention; immutable where required |
| 6 | Key Vault | Azure Key Vault | Secrets, connection strings, signing material | Managed-identity access; purge protection in prod |
| 7 | Application Insights + Log Analytics | Azure Monitor | Structured logs, traces, correlation, dashboards | Secret-scrubbing on ingestion |
| 8 | Document Intelligence | Azure AI Document Intelligence | OCR/layout + prebuilt/custom extraction | Private endpoint where supported; data-retention policy |
| 9 | AI Foundry | Azure AI Foundry | Schema-constrained PO interpretation | Versioned deployment; usage/cost tracking; content safety |
| 10 | Managed Identities | Entra ID (user-assigned) | Workload identities for all apps | Least-privilege role assignments |
| 11 | Entra ID App Registrations | Entra ID | Frontend OIDC + protected backend API + Graph app perms | App roles: Administrator/Order Processor/Supervisor/Viewer/Integration Service |
| 12 | Virtual Network + Private Endpoints + Private DNS | Azure Networking | Private connectivity between apps and PaaS | Per-env VNet; NSGs |
| 13 | (optional) Front Door / App Gateway + WAF | Azure networking/security | TLS termination, WAF for the SPA/API | Confirm per hosting standards (Q-ENV-1) |
| 14 | (evaluate) Fabric Warehouse | Microsoft Fabric | **Only if** Boomi needs SQL-based transactional staging/acks (§11) | Decision: Lakehouse Delta write vs Warehouse — Q-FAB-2 |

## 6.2 External / already-existing (not provisioned by this project)

| System | Relationship | Access method |
|---|---|---|
| Microsoft 365 shared mailbox | Order intake | MS Graph, narrowly scoped application permissions + Exchange application-access scoping (Q-GRAPH-1) |
| Microsoft Fabric (Lakehouse/Warehouse) | Master-data read + order staging | Supported Fabric SQL endpoint/API; managed identity or approved service principal (Q-FAB-1) |
| Boomi | Owns AX integration | Consumes Fabric staging; sends acks (Q-BOOMI-1/2) |
| Dynamics AX 2012 | ERP of record | Reached **only** via Boomi — never written directly |

## 6.3 CI/CD & operations resources (§15)

- **Pipelines** (GitHub Actions or Azure DevOps — Q-ENV-2): build → lint → unit tests → security scan →
  container image → **DB migration check** → integration tests → controlled deploy with rollback.
- **Infrastructure changes reviewed** (PR-gated `terraform plan`).
- **Reliability resources**: DLQs (per Service Bus topic), poison-message quarantine, stuck-job sweeper
  (scheduled Container App job), Graph delta reconciliation job, Fabric publication reconciliation job,
  Boomi-ack timeout alert, backup/restore + DR test runbooks.
- **Observability**: dashboards for latency, queue depth, error rates, **AI cost**, straight-through-
  processing (STP) rate, matching quality, model drift. Never log raw secrets.

## 6.4 Environment matrix

| Concern | dev | test | prod |
|---|---|---|---|
| Resource group / identity boundary | isolated | isolated | isolated |
| Production mailbox | **never** (mock/dev mailbox) | dedicated test mailbox | real (read, controlled) |
| AX writes | **none** | **none** (Boomi sandbox if available) | via Boomi only, post-approval |
| Mocks/feature flags | allowed, labelled | allowed, labelled | off |
| Service Bus / PG tier | low | mid | HA + Premium |
