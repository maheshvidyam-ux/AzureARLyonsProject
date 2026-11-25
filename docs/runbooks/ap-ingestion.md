# Runbook — AP vendor-invoice ingestion (go-live)

The AP path mirrors AR: a **separate mailbox → separate Service Bus queue → invoice pipeline →
reviewer**. All AP *code* exists and is tested; this is the operator wiring. See
[graph-ingestion.md](graph-ingestion.md) for the AR equivalent.

## Topology

```
invoices@… (AP mailbox)
  → Graph subscription (clientState = AP secret)
  → API webhook  ──routes by clientState──▶  Service Bus queue  ingestion-ap
  → workers (InvoiceIngestionWorker)  → invoice pipeline  → ap_invoice_* + staging_vendor_invoice
  → reviewer API /invoices + SPA
```

The AR and AP subscriptions **must use different `clientState` secrets** — the single webhook
routes each mailbox's notifications to its own queue by which secret matched.

## 1. Infrastructure (Terraform)

Already in `infra/terraform`:
- the `ingestion-ap` Service Bus queue (servicebus module default queue set), and
- the per-app `env` mechanism on the container-apps module.

Set the dev-env variables and apply (PR-gated plan via `.github/workflows/infra-plan.yml`):

```hcl
# terraform.tfvars (or TF_VAR_*)
ar_mailbox = "orders@lyonsmagnus.com"
ap_mailbox = "invoices@lyonsmagnus.com"
```

This wires `MAILBOX` / `AP_MAILBOX` + `SERVICEBUS_NAMESPACE` + `INGESTION_QUEUE_NAME` /
`AP_INGESTION_QUEUE_NAME` onto the worker, and the queue names onto the API.

## 2. Secrets / env (Key Vault → container secret refs)

- **API** needs `GRAPH_CLIENT_STATE` (AR) and `GRAPH_CLIENT_STATE_AP` (AP) — distinct secrets. With
  `GRAPH_CLIENT_STATE_AP` set, the webhook publishes AP ids to `ingestion-ap`.
- **Workers** need the usual stack (`FABRIC_SQL_*`, `BLOB_ACCOUNT_URL`, `DOC_INTEL_ENDPOINT`,
  `AI_FOUNDRY_ENDPOINT`/`_DEPLOYMENT`, `LAKEHOUSE_SQL_SERVER`/`_DATABASE`) plus `AP_MAILBOX`.
  The AP branch activates only when `AP_MAILBOX` **and** `LAKEHOUSE_SQL_SERVER` are set. Optional:
  `AI_FOUNDRY_INVOICE_DEPLOYMENT` (invoice extraction deployment), `AP_INGESTION_QUEUE_NAME`.

The invoice master reader reads the **vendor/PO tables + columns** configured in the admin
**Settings → Connections** screen (persisted in `app_config`); edit them there, not in env.

## 3. Create the AP Graph subscription

A service principal with `Mail.Read` (application) scoped to the AP mailbox via an Exchange
application-access policy (Q-GRAPH-1):

```bash
AP_MAILBOX=invoices@lyonsmagnus.com \
  GRAPH_NOTIFICATION_URL=https://<api-fqdn>/integration/graph/notifications \
  GRAPH_CLIENT_STATE_AP=<ap-secret> \
  tsx apps/workers/src/ingestion/graph-cli.ts subscribe ap
```

(The AR subscription is the same command without `ap`, using `MAILBOX` + `GRAPH_CLIENT_STATE`.)
Graph subscriptions expire (~4230 min); renew on the `reauthorizationRequired` lifecycle event.

## 4. Verify

- Send a test invoice to the AP mailbox → a message lands on `ingestion-ap` → a vendor invoice
  appears in the reviewer (`GET /invoices` / the AP queue in the SPA).
- Clean PO-based invoices auto-stage (`STAGED`); Non-PO land `NEEDS_REVIEW` for GL coding.

GUARDRAIL (spec §18): dev only — no production mailbox / AX writes without sign-off.
