# ADR 0006 — Backend stack = TypeScript; hosting = Azure Container Apps

**Status:** Proposed — **blocked by Q-ENV-1/2/3**

## Context
The spec mandates Azure Container Apps for web/API/workers (§2, §15) but is language-agnostic. A stack
must be chosen to scaffold Phase 1.

## Decision (proposed)
- **Hosting:** Azure Container Apps for `web`, `api`, `workers` (per spec) — accepted.
- **Backend language (proposed):** **TypeScript** (Node + Fastify) for API/workers, **React + TS** for
  the SPA. Rationale: one language across API/workers/UI, first-class MS Graph + Azure SDKs, strong JSON
  Schema tooling for the PO schema. Alternatives: **.NET** (strong Azure/Entra + AX ecosystem affinity)
  or **Python** (AI tooling affinity). Any of the three maps onto the proposed repo tree.

## Consequences
- If the org standard is .NET (common where Dynamics AX exists), switch the backend — the repo tree,
  API contracts, data model, and PO schema are all stack-neutral and survive the change.
- Decision confirmed only after Q-ENV-3 (stack standard) and Q-ENV-1/2 (hosting/CI standards).
