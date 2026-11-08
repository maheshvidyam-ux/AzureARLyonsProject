# ADR 0003 — Transactional outbox for Fabric staging publication

**Status:** Accepted (spec §11)

## Context
Approval (PostgreSQL write) and publication to Fabric staging (external write) must not diverge: an order
marked approved but never staged, or staged twice, both break the AX pipeline.

## Decision
- On approval, write an `outbox_event` in the **same transaction** as the state change.
- A separate **retryable publisher** reads PENDING outbox events and writes complete validated
  header+lines to Fabric staging with **idempotent, stable IDs**.
- Reconcile by line-count/checksum; mark `RECONCILED` only after confirmation.
- Only fully validated orders with no blocking findings and a resolved duplicate claim are eligible.

## Consequences
- Exactly-once *effect* on staging even with retries/crashes (at-least-once delivery + idempotent write).
- A staged record is explicitly **not** a completed order; completion waits on the Boomi/AX ack chain.
- Requires the chosen Fabric write path to support idempotent upsert semantics (see ADR 0004 / Q-FAB-2).
