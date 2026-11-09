# Runbook — Go Live (dev): provision, deploy, connect a mailbox

End-to-end path to run the platform in Azure against a real order mailbox. Dev only (spec §18).

## 0. Prereqs
- `az login` to the target subscription; `terraform` ≥ 1.9; `docker`.
- Azure OpenAI access approved on the subscription (for AI Foundry).
- **M365/Entra admin** for the Graph permission in step 4 (you cannot self-grant app permissions).

## 1. Provision infrastructure
```bash
cd infra/terraform/envs/dev
cp terraform.tfvars.example terraform.tfvars   # set subscription_id, name_suffix, fabric_admin_members
terraform init && terraform plan -out tf.plan && terraform apply tf.plan
```
This creates the resource group, Container Apps env, ACR, Service Bus, Blob, Key Vault, managed
identities, **Document Intelligence + Azure OpenAI (`modules/ai`)**, and the Fabric capacity/workspace/
SQL database. Endpoints are in `terraform output`.

## 2. Apply the DB schema (SQL database in Fabric)
```bash
export FABRIC_SQL_SERVER=<sql endpoint>  FABRIC_SQL_DATABASE=<db name>
npx tsx packages/persistence/src/fabric-sql/migrate.ts up
```

## 3. Build + deploy the app images
```bash
MAILBOX=orders@lyonsmagnus.com GRAPH_CLIENT_STATE=<secret> \
  FABRIC_SQL_SERVER=<...> FABRIC_SQL_DATABASE=<...> \
  bash scripts/deploy-dev.sh
```
Then grant each app's **managed identity** the data-plane roles:
`Cognitive Services User` (DI), `Cognitive Services OpenAI User` (OpenAI),
`Storage Blob Data Contributor` (Blob), `Azure Service Bus Data Sender/Receiver`,
Fabric SQL access, and Graph `Mail.Read` (step 4). The Terraform already grants Blob/Service Bus/
KV/ACR/AI roles to the identities; Graph + Fabric SQL are granted out-of-band.

## 4. Connect the order mailbox (Graph) — Q-GRAPH-1
1. Grant the app (or workers' managed identity) the Graph **`Mail.Read` application** permission; admin consent.
2. Scope it to just the mailbox (least privilege, spec §3):
   ```powershell
   New-ApplicationAccessPolicy -AppId <appId> -PolicyScopeGroupId orders@lyonsmagnus.com `
     -AccessRight RestrictAccess -Description "COA order mailbox only"
   ```
3. Create the change subscription to the deployed API:
   ```bash
   MAILBOX=orders@lyonsmagnus.com GRAPH_NOTIFICATION_URL=https://<api-fqdn>/integration/graph/notifications \
     GRAPH_CLIENT_STATE=<secret> npx tsx apps/workers/src/ingestion/graph-cli.ts subscribe
   ```

## 5. Test
- **Quick, no deployment:** with a service principal holding `Mail.Read`
  (`AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_CLIENT_SECRET`):
  ```bash
  MAILBOX=orders@lyonsmagnus.com npx tsx apps/workers/src/ingestion/graph-cli.ts poll
  ```
  Lists new messages + attachments straight from the mailbox.
- **Full loop:** send a PO email → webhook verifies `clientState` → Service Bus → workers fetch →
  **Document Intelligence → AI Foundry** → normalize/validate → **SQL database in Fabric**. Inspect
  with `scripts/verify-fabric-schema.mts` or the reviewer API.

## Live-test the AI clients in isolation first
```bash
export DOC_INTEL_ENDPOINT=<...> DOC_INTEL_SAMPLE_URL=<https sample PO pdf>
npx vitest run tests/e2e/azure-di.test.ts
export AI_FOUNDRY_ENDPOINT=<...> AI_FOUNDRY_DEPLOYMENT=gpt-4o-po
npx vitest run tests/e2e/azure-foundry.test.ts
```

## Known gaps before this is production-grade
- Master matching + duplicate claim need the **Fabric read adapter** (Q-FAB-1); the worker runs with
  matching deferred until then.
- Images run via `tsx` (not compiled/bundled) — a hardening follow-up.
- Reviewer API routes await the **Entra OIDC authenticator** before being served publicly.
- A custom PO **Document Intelligence model** (or confirm `prebuilt-invoice`) + data-retention review (§3).
