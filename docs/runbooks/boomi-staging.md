# Runbook — Phase 5: Boomi Staging ("final tables")

The destination Boomi polls to create AX sales orders (spec §8/§5, ADR 0003/0004). An order reaches
here only when it is safe to create in AX.

## The flow

```
clean + matched + duplicate-claimed ──auto-stage──►  dbo.staging_sales_order (publish_status = READY)
needs review / duplicate / invalid  ──► CSR corrects + approves in the app ──► staged (READY)
                                                                                   │
Boomi polls READY → claims → creates AX SO → ack ──► markBoomiResult ──► COMPLETED (+ AX SO id)
```

- **Straight-through:** the worker auto-stages a READY order when masters are wired
  (`PipelineDeps.autoStage`, on in the worker entrypoint). State → `STAGED`, status "Ready".
- **CSR path:** anything in review is NOT staged. The CSR fixes it in the reviewer app and **approves**
  (`POST /orders/:id/approve`), which stages it to the same tables.
- Nothing invalid or duplicate ever stages (invariant #2 holds — the claim runs before staging).

## Tables (SQL database in Fabric, migration 0003)

- `dbo.staging_sales_order` — header Boomi reads: `data_area_id`, `erp_customer_account`,
  `customer_po_number`, `normalized_po_number`, `po_date`, `requested_delivery_date`, `currency`,
  `total`, `line_count`, **`publish_status`** (READY→CLAIMED→COMPLETED/FAILED), `ax_sales_order_id`.
  One row per operational order (`UQ_staging_order_header`, idempotent).
- `dbo.staging_sales_order_line` — `erp_item_id`, `customer_item_code`, `quantity`, `uom`, `unit_price`.

## Persistence API

- `stageOrder(orderHeaderId)` — publish (idempotent), sets the order `STAGED`.
- `listReadyForBoomi(limit)` — the pickup queue (`publish_status = READY`).
- `markBoomiResult(stagingId, { axSalesOrderId | error })` — the ack; completes the order
  (`ERP_CREATED`/Completed) + writes `integration_ack`.

## Tests

`tests/e2e/staging.test.ts` — auto-stage of a clean order; review order does NOT stage; Boomi
pickup + ack → Completed with AX SO id; CSR path stops at READY without auto-stage. Reviewer
approve→staged is in `tests/e2e/reviewer-api.test.ts`.

## Still to confirm / deferred

- The exact **canonical shape Boomi expects** is **Q-BOOMI-1** — this is a faithful starting shape.
- **Boomi pickup/ack mechanism** (push vs poll, claim semantics) is **Q-BOOMI-2** — `listReadyForBoomi` +
  `markBoomiResult` model a poll-and-ack; wire the real callback to `POST /integration/acknowledgments`.
- Staging target is co-located in Fabric SQL (single-transaction publish). A Lakehouse/Warehouse target
  (ADR 0004) would swap the write path.
- **Re-claim on CSR approval:** if a CSR changes the customer/PO number, the duplicate key changes — the
  claim should be re-attempted at approval time (hardening follow-up).
