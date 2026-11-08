# ADR 0007 — Operational datastore: Azure PostgreSQL vs. SQL database in Fabric

**Status:** ✅ **Accepted (2026-11-08) — Option B: SQL database in Fabric.** Supersedes ADR 0001.
(Open follow-ups tracked against Q-FAB-2, Q-ENV-1 — see "Accepted decision" below.)

## Accepted decision

The operational / UI backend is a **SQL database in Fabric** (transactional OLTP, SQL Server engine),
consolidating read-masters + order-staging + operational store on one Fabric capacity. The atomic
cross-channel duplicate claim is enforced by a **filtered unique index** on `duplicate_claim.business_key`
(see `db/migrations/0001_init.up.sql`). The persistence port abstraction keeps repositories engine-neutral.

**Mandatory follow-ups before production (do not skip):**
1. **Availability coupling mitigation** — Fabric capacity must not pause/throttle the operational path:
   set a reserved/no-pause capacity policy (or autoscale) and alert on capacity pressure. This is the
   accepted trade against spec invariants #1/#3.
2. **Concurrency proof** — load-test the filtered-unique-index duplicate claim under concurrent
   cross-channel arrivals (the Phase-3 acceptance gate: exactly one claim wins).
3. **Capacity/throughput + RPO/RTO** — confirm connection limits from the Container Apps workers and
   backup/PITR meet Q-ENV-1 targets.

## Context

ADR 0001 made **PostgreSQL the operational source of truth**, with Fabric strictly for reading master
data and staging approved orders. A proposal on the table is to instead host the operational/UI backend
database as a **SQL database in Fabric** (the transactional OLTP item type, *not* the Lakehouse SQL
analytics endpoint), consolidating the whole platform on one Fabric capacity.

This is technically credible and must not be confused with the spec §11 constraint. That constraint is
about the **Lakehouse SQL endpoint being read-oriented**; a *SQL database in Fabric* is a different
engine (the SQL Server family) that **is** transactional, supports unique/filtered indexes, and
auto-mirrors to OneLake. So the §11 warning does not, by itself, rule this out.

## Options

### A. Azure Database for PostgreSQL (current ADR 0001)
- **Pros:** operational store fully **decoupled** from Fabric capacity (separate availability/blast
  radius — supports invariants #1/#3); mature SLAs, connection scaling, DR/PITR; well-understood
  partial-unique-index for the atomic duplicate claim.
- **Cons:** a second platform to run/govern/bill; operational → analytics data needs an explicit path
  into OneLake for the learning store.

### B. SQL database in Fabric (proposed)
- **Pros:** one platform for read-masters + order-staging + operational store; unified Entra/governance/
  billing; **auto-mirrored to OneLake** (frees the learning/analytics path); T-SQL affinity for a
  Dynamics-AX shop; the atomic duplicate claim is expressible as a **filtered unique index** +
  transaction, so invariant #2 is satisfiable.
- **Cons / risks to verify before committing:**
  1. **Availability coupling** — operational uptime now depends on Fabric capacity. If capacity is
     paused/throttled, the order pipeline and reviewer UI stall. This is the direct tension with the
     spec's deliberate operational/Fabric separation (invariants #1, #3).
  2. **Capacity/throttling** — CU-based consumption and connection limits under load from Container
     Apps workers; confirm it meets the Q-ENV-1 throughput + RPO/RTO targets.
  3. **Preview maturity** — confirm GA status, backup/PITR, max connections, and regional/residency
     fit for production at decision time.

## Decision rationale

Option B was chosen to consolidate the platform on a single Fabric capacity and get automatic OneLake
mirroring for the learning/analytics store, accepting the availability-coupling trade (mitigated by
follow-up #1 above). The persistence boundary is already abstracted (the first slice writes through an
in-memory store behind a port; `packages/persistence` is the adapter seam), so the engine choice stays
isolated from pipeline logic.

## Consequences

- Terraform targets a `modules/fabric-sqldb` (not `modules/postgres`); DDL is T-SQL under `db/migrations/`.
- The duplicate claim uses a T-SQL **filtered unique index**; `jsonb` columns become `nvarchar(max)` +
  `ISJSON` checks; UUIDs are `uniqueidentifier`.
- Availability-coupling mitigation (follow-up #1) is a hard gate before production rollout (Phase 7).
