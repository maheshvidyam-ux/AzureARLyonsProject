# Customer Order Automation — First Response (Planning Package)

> Per spec §18 "First response required" and Appendix A: **no code is written yet.** This package
> is the required pre-implementation deliverable set. Implementation proceeds one tested vertical
> slice at a time only after the Phase-0 open questions (see `07-contract-questions.md`) are answered
> and reviewed.

## What this is

A planning package for the Azure-native **Customer Order Automation** platform described in
`Customer_Order_Automation_Azure_Implementation_Specification.pdf` (v1.0, Nov 2026).

**Mission (one sentence):** Receive customer purchase orders by Microsoft 365 email → extract with
Azure AI Document Intelligence + AI Foundry → validate against Microsoft Fabric customer/item masters
→ block duplicates across Email **and** EDI → resolve exceptions in a reviewer UI → publish approved
orders to Fabric staging for the **existing** Boomi EDI-850 subprocess that creates Dynamics AX 2012
sales orders → learn from every correction.

## Reading guide

| # | Document | Spec sections covered |
|---|----------|-----------------------|
| 01 | [Architecture & data flow](01-architecture.md) | §2, §15 |
| 02 | [Proposed repo tree](02-repo-tree.md) | §18 |
| 03 | [Data model / ERD](03-data-model-erd.md) | §12 |
| 04 | [Normalized PO JSON schema](04-po-schema.json) + [notes](04-po-schema-notes.md) | §5 |
| 05 | [API contracts](05-api-contracts.md) | §13 |
| 06 | [Azure resource list](06-azure-resources.md) | §2, §15 |
| 07 | [Contract questions / decisions to verify](07-contract-questions.md) | §1, §11, §17 |
| 08 | [Threat model (STRIDE)](08-threat-model.md) | §3 |
| 09 | [Phased backlog & gap analysis](09-backlog-gap-analysis.md) | §17 |
| 10 | [Risks & assumptions](10-risks-assumptions.md) | §18 |
| — | [ADR log](adr/) | cross-cutting |

## The three load-bearing design invariants (from the spec)

1. **A SQL database in Fabric is the operational source of truth** for state, corrections, jobs, audit
   and duplicate reservations (transactional OLTP — ADR 0007, supersedes ADR 0001's PostgreSQL choice).
   **The Fabric Lakehouse/Warehouse is read-only reference data + the order-integration staging
   destination.** **Blob holds original documents. Boomi owns AX integration.** "AI suggests;
   deterministic rules authorize staging." (§2)
2. **No invalid or duplicate order may ever reach AX.** Duplicates are blocked across *both* Email and
   EDI channels via an atomic PostgreSQL claim on `normalized_customer_PO + AX_customer_account +
   legal_entity`, coordinated cross-channel with Boomi/AX. (§8, §16)
3. **Nothing touches production.** No production ERP writes, no production mailbox mutations, no
   unreviewed infra deploys during development. Mocks/feature flags for test environments only, clearly
   labelled. (§3, §18)

## Status of the local repository (Phase-0 finding)

The working directory currently contains **only** the specification PDF and a `.claude/` settings
folder — it is **not** a git repository. The spec repeatedly references two external baselines that
are **not present locally**:

- the **existing AP Automation patterns** (design inspiration), and
- the **existing Boomi EDI 850 implementation** (the AX integration baseline).

Obtaining these two artifacts is the top Phase-0 blocker. See `09-backlog-gap-analysis.md`.
