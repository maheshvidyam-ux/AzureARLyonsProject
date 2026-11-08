# 05 — API & Service Contracts

Covers spec §13. OpenAPI is the source of truth (lives in `apps/api/src/openapi`). Routes adapt to final
repository conventions. All endpoints: OIDC/Entra auth, app-role authorization enforced **server-side and
per action**, correlation IDs, structured errors, pagination on collections, idempotency keys on unsafe
writes, and optimistic concurrency (ETag/`row_version`) on reviewer edits.

## 5.1 Core order APIs

| Method | Route | Role(s) | Notes |
|---|---|---|---|
| GET | `/orders` | Viewer+ | Paginated, filter by status/customer/PO/company/SLA-age/confidence/error-count |
| GET | `/orders/{id}` | Viewer+ | Full header+lines+validation+evidence |
| PATCH | `/orders/{id}` | Order Processor+ | Edit header/lines; requires `If-Match` ETag; triggers revalidation flag |
| POST | `/orders/{id}/revalidate` | Order Processor+ | Re-runs deterministic validation (also auto-run before staging) |
| POST | `/orders/{id}/approve` | Order Processor+ | Blocked if any `blocking` finding or open duplicate; emits outbox event |
| POST | `/orders/{id}/reject` | Order Processor+ | Requires reason; terminal `Rejected` |
| GET | `/orders/{id}/history` | Viewer+ | `order_status_history` + audit timeline |
| GET | `/orders/{id}/document` | Viewer+ | Streams original from Blob (SAS-scoped / proxied) |
| GET | `/orders/{id}/matches` | Viewer+ | Candidate customer/item matches + evidence/alternatives |

## 5.2 Learning APIs (§13)

| Method | Route | Role(s) | Notes |
|---|---|---|---|
| POST | `/learning/feedback` | Order Processor+ | Records `learning_event` (original vs corrected, coords, anchors) |
| GET | `/learning/patterns` | Supervisor+ | List `extraction_pattern` (CANDIDATE/TRUSTED/DISABLED) |
| GET | `/learning/explanations/{order_id}` | Viewer+ | Evidence-backed explanation for each suggestion |
| GET | `/learning/metrics` | Supervisor+ | Accuracy, STP, drift, pattern success counts |
| POST | `/learning/patterns/{id}/approve` | Supervisor+ | Promote toward TRUSTED (threshold-gated) |
| POST | `/learning/patterns/{id}/disable` | Supervisor+ | Kill-switch a learned pattern |

## 5.3 Admin & integration APIs (§13)

| Method | Route | Role(s) | Notes |
|---|---|---|---|
| GET / PUT | `/settings` | Administrator | Config (thresholds, required fields, tolerances); no secrets in body |
| POST | `/connections/{type}/test` | Administrator | Health-check Graph/Fabric/Boomi/Blob/AI connectors |
| GET | `/jobs` | Supervisor+ | Processing jobs + attempts, failure reasons |
| POST | `/jobs/{id}/retry` | Supervisor+ | Re-drive a failed job (idempotent) |
| POST | `/integration/acknowledgments` | **Integration Service** (Entra service auth) | Boomi/AX callback: accepted / AX SO id / error |
| GET | `/health` | anon/liveness | Liveness + dependency readiness |
| GET | `/metrics` | scraper | Prometheus/OpenMetrics |

## 5.4 Contract requirements (§13) — enforced globally

- **OpenAPI** document generated + validated in CI; breaking-change check gate.
- **Strict JSON validation** on every request/response (reject unknown fields on writes).
- **Pagination**: cursor-based on `/orders`, `/jobs`, `/learning/patterns`.
- **Authorization**: deny-by-default; role checked per route **and** per action (e.g. approve ≠ view).
- **Correlation IDs**: `x-correlation-id` accepted/propagated across Graph→OCR→AI→Fabric→Boomi→AX.
- **Idempotency keys**: required header on POST approve/reject/retry/feedback/acknowledgments.
- **Structured errors**: RFC 9457 problem+json (`type`, `title`, `status`, `detail`, `errors[]`).
- **Rate limits**: per-principal; stricter on expensive actions (revalidate, connection test).
- **Optimistic concurrency**: `ETag` on GET order, `If-Match` required on PATCH; 412 on stale edit.

## 5.5 Webhook & async contracts (not in §13 list but required by §4/§11)

| Interface | Direction | Contract |
|---|---|---|
| Graph change-notification endpoint | inbound | Validate `clientState`/tokens; respond to validation handshake; renew subscription; reconcile via delta query |
| Service Bus topics | internal | `ingestion`, `extraction`, `validation`, `publish`, `reconcile`; DLQ per topic |
| Fabric staging write | outbound | Idempotent Delta write of complete header+lines; line-count/checksum reconciliation (Q-FAB-2) |
| Boomi ack ingestion | inbound | Via `/integration/acknowledgments` or agreed pull — see Q-BOOMI-2 |

> A staged record is **not** a completed order (§11). `/orders/{id}` surfaces `publish_state` and the
> `integration_ack` chain so UI/ops can tell "staged" from "AX created".
