# ADR 0004 — Fabric staging write path: Lakehouse Delta vs Warehouse

**Status:** Proposed — **blocked by Q-FAB-2** (and Boomi connector behavior)

## Context
Spec §11 flags a hard technical constraint: the Fabric **Lakehouse SQL analytics endpoint is generally
read-oriented — do not assume transactional DML.** Yet we must write approved orders to staging and
possibly surface acknowledgments, which Boomi then consumes.

## Options
1. **Lakehouse Delta write** via supported path (pipeline / notebook / API). Good for append-style
   staging; idempotency via stable keys + merge. Requires confirming Boomi can read the Lakehouse SQL
   endpoint for its intake.
2. **Fabric Warehouse** if Boomi needs SQL-based *operational* staging with transactional reads/updates
   and ack write-back.

## Decision (pending)
Select based on two facts to gather: (a) actual Fabric write capabilities exposed to us (Q-FAB-2),
(b) how the existing Boomi connector reads staging and writes acks (Q-BOOMI-1/2). **Do not build the
publisher against an assumed capability.** Provide a thin `boomi-adapter` seam so the write target can be
swapped without touching upstream pipeline code.

## Consequences
- Publisher (ADR 0003) is written against an interface, not a concrete Fabric API, until this is settled.
- Wrong choice risks either non-transactional staging corruption or unnecessary Warehouse cost.
