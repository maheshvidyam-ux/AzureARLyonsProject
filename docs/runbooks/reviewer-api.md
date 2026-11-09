# Runbook — Phase 4: Reviewer Workbench API

First Phase-4 slice (spec §13, §14). The server-side backbone of the Review UX: queue, order detail
with evidence, **optimistic-concurrency** edits (edits never lost), approve/reject, and server-side
**role enforcement**. Driveable via Fastify `inject`; the React SPA (two-pane PDF viewer with
bounding-box highlight) is the next sub-slice and consumes these contracts.

## Endpoints (`apps/api/src/routes/orders.ts`)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/orders?company=&state=&limit=` | any authenticated | queue (filter by company/state) |
| GET | `/orders/:id` | any authenticated | detail: header, lines, validation, **normalized PO (evidence)**; `ETag: <rowVersion>` |
| PATCH | `/orders/:id` | OrderProcessor/Supervisor/Administrator | edit header+line fields; requires `If-Match: <rowVersion>` |
| POST | `/orders/:id/approve` | write roles | NEEDS_REVIEW → READY; `If-Match` required |
| POST | `/orders/:id/reject` | write roles | → REJECTED; `If-Match` required |

**Optimistic concurrency:** every mutation requires `If-Match: <rowVersion>` (the `ETag` from GET).
A stale version → **409** with the current `rowVersion`; missing header → **428**. Viewer role on a
mutation → **403**; no principal → **401**.

## Auth

`apps/api/src/auth.ts` defines the app roles (Administrator / OrderProcessor / Supervisor / Viewer /
IntegrationService) and the `Authenticator` seam. A **DEV-only** header authenticator
(`x-dev-user` / `x-dev-roles`) backs tests and local runs. **Real Entra OIDC validation is a later
slice** — the reviewer routes are therefore NOT yet wired into the public entrypoint (`index.ts`); serving
them with dev-header auth on a reachable endpoint would be a security hole (spec §3).

## Persistence

`@coa/persistence` gained `listOrders`, `getOrderForReview`, `updateOrderFields` (row_version guarded),
`reviewDecision` — implemented for both the in-memory store (tests) and SQL database in Fabric
(`row_version` optimistic update + `order_status_history` + `audit_event`). The in-memory store now
retains full header fields, lines, and the normalized PO so detail/edit work offline.

## Tests

`tests/e2e/reviewer-api.test.ts` — 401/403 enforcement, queue + detail (ETag), 428 without If-Match,
successful edit (version bump + read-back), 409 on stale edit, approve → Ready, reject → Rejected, 404.

## Next sub-slices

- React SPA (`apps/web`): inbox/queue, **two-pane PDF viewer** with bounding-box highlight + source-to-
  field, editable header/lines with the optimistic-concurrency client, duplicate comparison, activity
  timeline, accessibility (no color-only status).
- **Entra OIDC authenticator** replacing the dev header auth, then wire `/orders` into the entrypoint.
- `revalidate` endpoint (re-run validation on edited values).
