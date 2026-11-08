# Infrastructure (Terraform)

Phase 1 foundation (spec §15, docs/06). Parameterized per environment under `envs/{dev,test,prod}`,
composed from reusable `modules/*`. **Separate resource group + identity boundary per environment.**

## What it provisions (dev)

| Module | Resource(s) | Notes |
|---|---|---|
| `identity` | 3 user-assigned managed identities (`api`, `workers`, `web`) | least-privilege workload identities |
| `monitor` | Log Analytics + Application Insights | app telemetry wired into Container Apps |
| `network` | VNet + delegated subnet | Container Apps VNet integration |
| `keyvault` | Key Vault (RBAC-only) + `Key Vault Secrets User` grants | no access policies, no admin secrets |
| `acr` | Container Registry + `AcrPull` grants | managed-identity pull, admin user off |
| `servicebus` | Namespace + 5 work queues (DLQ on expiry) | Data Sender/Receiver to api+workers |
| `blob` | Storage account + `originals`/`ocr-raw` containers | Blob Data Contributor to api+workers |
| `fabric-sqldb` | **Fabric capacity → workspace → SQL database** | operational source of truth (ADR 0007) |
| `container-apps` | Environment + `web`/`api`/`workers` apps | placeholder hello-world image (Phase-1 exit) |

> ADR 0007 note: the old PostgreSQL resource (docs/06 row 3) is replaced by **SQL database in Fabric**.
> ADR 0007 follow-up #1 (capacity no-pause/reserved policy) is a prod hardening gate.

## Prerequisites

- Terraform ≥ 1.9, Azure CLI logged in (`az login`) to the target subscription.
- The identity running Terraform needs rights to create the resource group + a Fabric capacity.

## Apply (dev)

```bash
cd infra/terraform/envs/dev
cp terraform.tfvars.example terraform.tfvars   # then edit: subscription_id, name_suffix, fabric_admin_members
terraform init
terraform plan -out tf.plan        # PR-gated review (spec §15 / §18 — no unreviewed infra deploys)
terraform apply tf.plan
```

Validate-only (no credentials needed):

```bash
terraform -chdir=infra/terraform/envs/dev init -backend=false
terraform -chdir=infra/terraform/envs/dev validate
```

## After provisioning: apply the DB schema

The Fabric SQL database is created empty. Apply the operational schema with the migration runner:

```bash
export FABRIC_SQL_SERVER="<sql endpoint of the Fabric SQL database>"
export FABRIC_SQL_DATABASE="coa-operational"
npm run -w @coa/persistence ... # or: tsx packages/persistence/src/fabric-sql/migrate.ts up
```

See `db/README.md`. The `FABRIC_SQL_SERVER`-gated integration test then exercises it end to end.

## State

Local state by default (gitignored). Before shared use, enable the remote `azurerm` backend in
`envs/dev/backend.tf`. Commit `.terraform.lock.hcl`; never commit `*.tfstate` or `*.tfvars`.

## test / prod

`envs/test` and `envs/prod` reuse the same modules with hardened inputs (Premium Service Bus, ACR
Premium + private endpoints, Key Vault purge protection, larger Fabric SKU with a no-pause policy, HA).
They are stubbed until the dev env is validated against real Azure and Q-ENV-1 standards are confirmed.
