# 07 — Contract Questions / Decisions to Verify (Phase-0 Blockers)

Consolidates the spec's "Decisions to verify" (§1), the Fabric technical constraint (§11), and the
Phase-0 discovery list (§17). These must be answered and reviewed **before** the dependent slice is
built. Each has an ID referenced throughout the other docs. Owner column = who must supply the answer.

## Boomi / AX integration (highest-leverage — gates Phase 5)

| ID | Question | Why it blocks | Owner |
|---|---|---|---|
| Q-BOOMI-1 | Provide the existing **inbound EDI 850 canonical payload** structure + process map and reusable subprocess boundaries. | The Fabric→canonical adapter must target the real schema; the whole AX path reuses this. | Integration team |
| Q-BOOMI-2 | **Acknowledgment mechanism**: push callback to `/integration/acknowledgments`, or pull/poll? What claim/read semantics on staging? | Determines ack ingestion design + Boomi-timeout alerting. | Integration team |
| Q-BOOMI-3 | Boomi/AX **cross-channel idempotency**: how does Boomi prevent the same order from EDI and Email both creating an AX SO? | Our PG claim must coordinate with this; otherwise duplicates can still reach AX. | Integration + ERP |
| Q-AX-1 | AX **duplicate-check approach** today and the authoritative feed/query for "AX sales orders exist?" | Needed for the AX side of cross-channel duplicate lookup (§8). | ERP team |
| Q-AX-2 | AX **legal entities** (`dataAreaId` list) in scope. | Company partitioning in matching, dup keys, payloads (§7). | ERP team |
| Q-AX-3 | Are **order revisions/releases** supported downstream after AX creation? | Governs whether we model revisions and how dup key handles them. | ERP + business |

## Microsoft Fabric

| ID | Question | Why it blocks | Owner |
|---|---|---|---|
| Q-FAB-1 | Actual **table schemas** for customer & item masters (fields, cross-refs, status, UOM conversions) + refresh cadence. | "Do not invent fields or assume all exist" (§6). Matching logic depends on real columns. | Data/Fabric team |
| Q-FAB-2 | **Staging write path**: Lakehouse Delta (pipeline/notebook/API) vs **Fabric Warehouse** if Boomi needs SQL-based operational staging/acks. | §11: Lakehouse SQL endpoint is read-oriented; wrong choice breaks publish/ack. | Data/Fabric + Integration |
| Q-FAB-3 | Supported **read access pattern** (SQL endpoint/API) + managed identity vs approved service principal. | Fabric read-model client design (§6). | Data/Fabric team |
| Q-FAB-4 | **Data freshness SLA** + cache invalidation expectation for the local read model. | Defines "stale master data" controlled-exception behavior (§6). | Data + business |

## Microsoft Graph / mailbox

| ID | Question | Why it blocks | Owner |
|---|---|---|---|
| Q-GRAPH-1 | Mailbox **address** + whether **Exchange application-access scoping** is available for narrow app permissions. | Least-privilege Graph access (§3); security review gate. | M365 admin |
| Q-GRAPH-2 | Folder structure to monitor; move/categorize policy after durable ingestion. | Ingestion config (§4). | Business + M365 admin |

## Business policy / validation

| ID | Question | Why it blocks | Owner |
|---|---|---|---|
| Q-DUP-1 | **PO-number normalization rule** (case, punctuation, leading zeros, prefixes). | It is a component of the atomic duplicate business key (§8). | Business |
| Q-DUP-2 | Handling of **revisions, releases, blanket orders, cancellations, split shipments** in the dup key. | "Confirm before finalizing" (§8). Changes key + schema. | Business + ERP |
| Q-VAL-1 | **Validation policy**: required fields, date rules, currency, **price tolerances**, quantity/total rules, ship-to rules, approval thresholds. | Deterministic rules authorize staging (§7). | Business |
| Q-PRICE-1 | **Pricing policy**: is `unit_price` validated, informational, or ignored? | Line schema requiredness + price-rule validation (§1, §7). | Business |

## Hosting / security standards

| ID | Question | Why it blocks | Owner |
|---|---|---|---|
| Q-ENV-1 | Approved **hosting/security standards**: allowed regions, networking (Front Door/WAF?), private-endpoint requirements, data residency, retention periods, RPO/RTO. | Terraform + threat-model finalization (§3, §15). | Platform/Security |
| Q-ENV-2 | CI/CD platform: **GitHub Actions vs Azure DevOps**; branch/deploy approval model. | Pipeline implementation (§15). | Platform |
| Q-ENV-3 | **Stack decision**: TS vs .NET vs Python for API/workers (proposal: TS). | Repo scaffolding. | Eng lead |

## Inputs/artifacts to obtain (§17 Phase 0)

- [ ] Existing **AP Automation patterns** repo/docs (design inspiration — *not present locally*).
- [ ] Existing **Boomi EDI 850 implementation** (AX integration baseline — *not present locally*).
- [ ] Representative **PO sample set** (clean, scanned, rotated, multi-page, multi-order, unknown
      template) for extraction tuning + the §16 test matrix.
- [ ] Fabric schema exports (Q-FAB-1).

> Deliverable of Phase 0 (per §17): **ADRs** (see `adr/`) + this **gap analysis**
> (`09-backlog-gap-analysis.md`).
