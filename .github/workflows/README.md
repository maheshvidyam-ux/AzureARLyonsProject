# CI/CD

GitHub Actions (provisional — CI/CD platform is **Q-ENV-2**, GitHub Actions vs Azure DevOps; this
repo scaffolds Actions as the proposed default). Pipeline shape follows spec §15 / docs/06.3.

## Workflows

### `ci.yml` — quality gate (no cloud credentials)
Runs on every push to `main` and every PR. Two parallel jobs:
- **app**: `npm ci` → typecheck → lint → migration-pairing check → tests → production-dependency
  security audit (`npm audit --omit=dev --audit-level=high`).
- **infra**: `terraform fmt -check` + `terraform validate` (dev env, no backend).

This is the mergeable gate and needs no secrets, so it works on forks.

### `infra-plan.yml` — PR-gated `terraform plan` (OIDC)
Runs on PRs that touch `infra/terraform/**`. Authenticates to Azure via **OIDC** (no long-lived
secrets) and runs `terraform plan` against the `dev` environment under a protected `dev` GitHub
Environment. **Skips cleanly** unless the repo is configured, so it never blocks unconfigured repos.

To enable, set these repository (or `dev` environment) **Variables**:

| Variable | Purpose |
|---|---|
| `AZURE_CLIENT_ID` | OIDC app (federated credential) client id |
| `AZURE_TENANT_ID` | Entra tenant id |
| `AZURE_SUBSCRIPTION_ID` | target subscription |
| `COA_NAME_SUFFIX` | unique suffix for globally-unique resource names |
| `COA_FABRIC_ADMIN_MEMBERS` | JSON list, e.g. `["you@tenant.onmicrosoft.com"]` |

The federated credential must trust this repo's `dev` environment. `plan` is review-only; `apply`
stays manual + approval-gated (spec §18 — no unreviewed infra deploys).

## Deferred to Phase 2 (intentionally not scaffolded yet)

- **Container image build + push to ACR** and **app deploy** — there are no Dockerfiles yet (the
  Container Apps module runs a placeholder image). These land with the real `api`/`workers`/`web`
  images in Phase 2, as a manual, environment-approved `deploy` workflow.
- **DB migration apply** against Fabric SQL runs as a deploy step once a dev Fabric SQL database is
  provisioned (`db/README.md`), gated the same way.
