# Customer Order Automation

Azure-native platform that receives customer purchase orders by Microsoft 365 email, extracts them with
Azure AI Document Intelligence + AI Foundry, validates against Microsoft Fabric customer/item masters,
blocks duplicates across Email **and** EDI, resolves exceptions in a reviewer UI, and publishes approved
orders to Fabric staging for the **existing** Boomi EDI-850 subprocess that creates Dynamics AX 2012
sales orders — learning from every correction.

> Spec: `Customer_Order_Automation_Azure_Implementation_Specification.pdf` (v1.0, Nov 2026).

## Status

**Phase 0 — Discovery.** No application code yet. Per spec §18, the first deliverable is a planning
package, not code. See **[`docs/00-first-response.md`](docs/00-first-response.md)** for the full set:
architecture, repo tree, ERD, PO JSON schema, API contracts, Azure resources, contract questions, threat
model, backlog/gap analysis, risks, and ADRs.

Implementation begins — one tested vertical slice at a time — only after the Phase-0 open questions in
[`docs/07-contract-questions.md`](docs/07-contract-questions.md) are answered and reviewed.

## Guardrails (do not violate)
- PostgreSQL = operational source of truth; Fabric = read masters + order staging; Boomi owns AX.
- No duplicate/invalid order may reach AX (atomic cross-channel claim).
- No production ERP writes, no production mailbox changes, no unreviewed infra deploys during development.

## Repo layout (planned)
See [`docs/02-repo-tree.md`](docs/02-repo-tree.md). Today the repo contains the spec and the `docs/`
planning package.
