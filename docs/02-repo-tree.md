# 02 — Proposed Repository Tree

A single monorepo. Language/runtime choices are **proposals** pending the "hosting/security standards"
Phase-0 input (see `07-contract-questions.md` Q-ENV-1); the structure is stack-agnostic enough to swap.
Default proposal: **TypeScript** API/workers (Node + Fastify) and **React** SPA, because it keeps one
language across API/workers/UI and has first-class MS Graph / Azure SDKs — but a Python or .NET backend
maps onto the same tree. The structure reflects the spec's module-scoped architecture (§10): keep a
`module_code` seam for future modules without building tenant management.

```
AzureAPProject/
├─ docs/                          # this planning package + ADRs + runbooks
│  ├─ 00-first-response.md
│  ├─ 01-architecture.md … 10-risks-assumptions.md
│  ├─ adr/                        # architecture decision records
│  └─ runbooks/                   # operational runbooks (per phase deliverable, §18)
│
├─ apps/
│  ├─ web/                        # Reviewer SPA (React + TS)
│  │  ├─ src/
│  │  │  ├─ pages/                # §14 page inventory (inbox, review, duplicate, etc.)
│  │  │  ├─ components/pdf-viewer/# two-pane viewer + bounding-box highlight
│  │  │  ├─ features/{orders,learning,admin}/
│  │  │  └─ lib/{auth-oidc,api-client}/
│  │  └─ tests/
│  │
│  ├─ api/                        # HTTP API service (Container App)
│  │  ├─ src/
│  │  │  ├─ http/                 # routes = §13 contracts; OpenAPI source of truth
│  │  │  ├─ auth/                 # Entra OIDC, app-role enforcement (server-side)
│  │  │  ├─ graph/                # webhook receiver, subscription renewal, delta
│  │  │  └─ openapi/              # generated + hand-authored spec
│  │  └─ tests/
│  │
│  └─ workers/                    # async processors (Container App, Service Bus consumers)
│     ├─ src/
│     │  ├─ ingestion/            # Graph → durable record → Blob
│     │  ├─ classification/
│     │  ├─ extraction/           # Document Intelligence client + evidence capture
│     │  ├─ interpretation/       # AI Foundry client, schema-constrained, versioned prompts
│     │  ├─ validation/           # deterministic rules, errors vs warnings
│     │  ├─ duplicate/            # atomic claim + cross-channel lookup
│     │  ├─ publishing/           # transactional outbox publisher → Fabric staging
│     │  ├─ reconciliation/       # delta, publication, Boomi-ack timeout sweepers
│     │  └─ learning/             # feedback events, first-correction pattern reuse
│     └─ tests/
│
├─ packages/                      # shared libraries (imported by api + workers)
│  ├─ domain/                     # entities, PO schema types, status machine
│  ├─ po-schema/                  # JSON Schema (04) + validators + codegen
│  ├─ fabric-read/                # Fabric SQL endpoint client + indexed read model
│  ├─ boomi-adapter/              # thin Fabric→canonical-850 adapter (reuses Boomi maps)
│  ├─ persistence/                # PG access, migrations, outbox, repositories
│  ├─ messaging/                  # Service Bus abstractions, DLQ, retry/backoff
│  ├─ observability/              # structured logs, correlation IDs, metrics, cost tracking
│  └─ security/                   # Key Vault, managed identity, PII redaction, malware screen hooks
│
├─ db/
│  ├─ migrations/                 # versioned, with rollback (§12)
│  └─ seeds/                      # roles/config only — NO secrets, NO business data
│
├─ infra/
│  └─ terraform/
│     ├─ modules/{container-apps,postgres,servicebus,blob,keyvault,acr,monitor,ai,network}/
│     └─ envs/{dev,test,prod}/    # parameterized; separate identity boundaries
│
├─ mocks/                         # test-env-only fakes, clearly labelled (§18)
│  ├─ graph/                      # fake mailbox / webhook emitter
│  ├─ fabric/                     # sample master data + staging sink
│  ├─ boomi/                      # canonical-850 consumer stub + ack emitter
│  └─ ai/                         # recorded DI + Foundry responses
│
├─ samples/                       # sample PO PDFs + expected normalized payloads (§18)
│
├─ tests/
│  ├─ integration/                # cross-component slices
│  └─ e2e/                        # §16 critical test cases + acceptance gate
│
├─ .github/workflows/ (or az-pipelines/)  # §15: build, lint, test, scan, image, migration-check, deploy
├─ .claude/
└─ README.md
```

## Conventions this tree encodes

- **Vertical slices, not layers at the top level** (§18): each worker subfolder is a slice with its
  own tests.
- **OpenAPI as the API contract source of truth** lives in `apps/api/src/openapi` (§13).
- **Migrations have rollback** and seed only roles/config, never secrets or production data (§12).
- **Mocks are quarantined** under `mocks/` so there is no path for them to reach production builds (§18).
- **`module_code` seam** lives in `packages/domain` so Order Processing is the first module without
  building multi-tenant/multi-module management now (§10).
