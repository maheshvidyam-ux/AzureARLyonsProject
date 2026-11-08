# ADR 0001 — PostgreSQL is the operational source of truth; Fabric is read + staging

**Status:** ⚠️ **SUPERSEDED by [ADR 0007](0007-operational-datastore.md)** (2026-11-08). The operational
source of truth is now a **SQL database in Fabric** (transactional OLTP), not Azure PostgreSQL. The
*separation of concerns* below still holds — operational state is distinct from the read-only masters and
the staging destination — only the operational engine changed. Read "PostgreSQL" below as "the
operational store (now SQL database in Fabric)."

**Original status:** Accepted (mandated by spec §2)

## Context
The platform spans several systems with overlapping "where is the truth?" claims: email state (M365),
master data (Fabric), ERP orders (AX via Boomi), and our own workflow. Ambiguity here causes duplicate
orders and lost corrections.

## Decision
- **PostgreSQL** holds operational truth: order state, validation, jobs, audit, corrections, and the
  **duplicate reservations**.
- **Fabric** is the authoritative **read** source for customer/item masters and the **staging
  destination** for approved orders — never treated as our transactional store.
- **Blob** holds immutable original documents + raw OCR.
- **Boomi** owns AX integration; we never write AX directly.
- **Email status is not workflow truth** (§4): we may move/categorize messages only *after* durable
  ingestion.

## Consequences
- All state transitions and the duplicate claim are ACID-protected in one store.
- Fabric unavailability degrades to a *controlled exception*, not data loss.
- Requires a local indexed read model for Fabric masters with freshness/health visible (§6).
