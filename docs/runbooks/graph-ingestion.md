# Runbook — Phase 2: Microsoft Graph Ingestion Adapter

First Phase-2 slice (spec §4). Replaces the fake mailbox with a real Microsoft Graph adapter behind the
existing `GraphSource` port, fully testable **without a live mailbox**. Uses `@azure/identity` for Entra
auth — no secrets, no new npm dependencies.

## Components (`apps/workers/src/ingestion/graph/`)

| File | Role |
|---|---|
| `graph-api-client.ts` | Low-level `GraphApiClient` port (delta page, attachments, subscription create/renew) — the test seam |
| `http-graph-api-client.ts` | Real HTTPS client: Entra bearer token (cached), injectable `fetch`, tight `$select` projection |
| `mailbox-source.ts` | `GraphMailboxSource implements GraphSource`: delta sweep + pagination, removed-item skipping, cursor persistence (`DeltaStore`), maps Graph message+file-attachments → `GraphMailMessage` |
| `notifications.ts` | Webhook handling (pure): validation-token handshake + **clientState-verified** notification parsing → message ids |
| `subscriptions.ts` | Subscription lifecycle: capped expiration, renewal-threshold logic, create/renew |
| `factory.ts` | `createDefaultGraphMailboxSource()` — wires `DefaultAzureCredential` → client → source |

## How it flows

```
Graph /messages/delta (paged) → skip @removed / attachment-less → fetch file attachments
  → GraphMailMessage → [existing pipeline] → normalized PO → validation → persist → stop before staging
```

Change notifications (webhook) are parsed by `parseNotifications` (clientState checked). The HTTP route
that hosts it now exists — see **Webhook route** below. Subscriptions are created/renewed via
`subscriptions.ts`.

## Webhook route (`apps/api/`)

A Fastify service (`POST /integration/graph/notifications`) hosts the webhook:
- `?validationToken=…` → echoes the token as `text/plain` (subscription handshake).
- JSON body → `parseNotifications` (clientState-verified) → `enqueueMessageIds` (→ Service Bus
  `ingestion` queue, stubbed for now) → **202 Accepted** fast; lifecycle events routed to a handler.

Also serves `GET /health`, `GET /ready`, `GET /metrics`. Build with `buildServer(deps)` (injectable for
tests via `app.inject()`); `apps/api/src/index.ts` is the Container App entrypoint. Config: `PORT`,
`HOST`, `GRAPH_CLIENT_STATE` (the subscription secret — from Key Vault in prod). Tests:
`tests/e2e/api-webhook.test.ts`.

## Ingestion worker + queue (`apps/workers/src/ingestion/ingestion-worker.ts`)

Closes the loop. The webhook's `enqueueMessageIds` publishes message ids onto the `ingestion` queue
(`@coa/messaging` — `IngestionQueue` port; in-memory now, Azure Service Bus in prod). The
`IngestionWorker`:

```
queue.receive() → getMessage(id) → mapGraphMessage (+attachments) → processAttachment × N
  → pipeline → persisted order → stop before staging
```

- **Failure isolation:** a message that can't be fetched/processed is captured on its `MessageOutcome.error`
  (for retry/dead-letter) and does **not** abort the batch.
- **Idempotent:** replaying a message id creates no duplicate order (persistence get-or-create).

Full loop tested in `tests/e2e/ingestion-worker.test.ts` (webhook inject → queue → `worker.drain()` →
orders persisted).

## Service Bus adapter (`@coa/messaging`)

`ServiceBusIngestionQueue` implements both sides over one Entra-authenticated `ServiceBusClient`:
- **`IngestionPublisher`** — the webhook's send side (`apps/api` picks Service Bus when
  `SERVICEBUS_NAMESPACE` is set, else a logging stub — see `apps/api/src/publisher.ts`).
- **`IngestionProcessor`** — peek-lock consumer with `autoCompleteMessages`: the handler resolving
  completes the message; the handler **throwing** abandons it and, after the queue's maxDeliveryCount,
  dead-letters it (retry/DLQ, spec §6.3).

`runIngestionConsumer(processor, worker)` is the bridge: it re-throws on `MessageOutcome.error` so failures
reach the DLQ, and resolves on success so the message completes. Config: `SERVICEBUS_NAMESPACE`
(`…​.servicebus.windows.net`), `INGESTION_QUEUE_NAME` (default `ingestion`). The Terraform `servicebus`
module already grants api+workers `Azure Service Bus Data Sender`/`Receiver`. Tests:
`tests/e2e/service-bus-adapter.test.ts` (bridge semantics + a `SERVICEBUS_NAMESPACE`-gated live round-trip).

## Tests (no live inbox)

- `tests/e2e/graph-ingestion.test.ts` — delta pagination + mapping + cursor; HTTP client request-building
  (fake `fetch`, token caching, error surfacing); notification clientState verification; subscription
  expiration/renewal math.
- `tests/e2e/graph-to-pipeline.test.ts` — a mailbox sweep → pipeline → **2 persisted orders** (READY +
  NEEDS_REVIEW), replay idempotent, delta cursor advances (second sweep returns nothing).

Run: `npm test` (all green, no credentials needed).

## Going live (gated on Q-GRAPH-1)

To point at the real shared mailbox:

```ts
const source = createDefaultGraphMailboxSource({ mailbox: "orders@…", folder: "Inbox" });
const messages = await source.fetchMessages(); // then runSlice(deps, messages)
```

Requires (Phase-0 Q-GRAPH-1 / Q-GRAPH-2):
- **Graph application permissions** `Mail.Read` (+ `MailboxSettings.Read` if needed), ideally scoped with
  **Exchange application-access policy** to just the order mailbox (spec §3 least-privilege).
- A reachable **notificationUrl** (the webhook route) for subscriptions, and a persisted `clientState`
  secret (Key Vault).
- A DB-backed `DeltaStore` (currently in-memory) so the delta cursor survives restarts.
