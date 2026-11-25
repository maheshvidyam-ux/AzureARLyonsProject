# Runbook — Go Live (dev): stand the app up for user testing

End-to-end path to run the AR+AP platform in Azure for real testers. Testers sign in with their
Entra (Lyons) account via **Container Apps Easy Auth**, upload PDFs and review results, and documents
also flow in from mailboxes via the **scheduled poll job**. Dev only (spec §18).

Each step is tagged **[You]** (needs a human / admin / approval) or **[Claude]** (code/build Claude
can do in-session). "Claude-assisted" means Claude prepares the command and you run the interactive bit.

## Topology (what gets deployed)
- **web** — public ingress, behind Entra Easy Auth. Serves the SPA and reverse-proxies `/api` to the
  internal API (forwarding the signed-in identity). The ONLY public surface.
- **api** — **internal** ingress only. Reviewer/upload/settings routes; trusts the Easy Auth identity
  header forwarded by web (so it must not be public). Uses real Document Intelligence + OpenAI.
- **workers** — no ingress. Consumes the Service Bus ingestion queues (AR + AP).
- **poll job** — cron (`*/5`), no-loss mailbox poll → enqueues new messages. Primary ingestion.

## 0. Prereqs
- **[You]** `az login` to the target subscription; `terraform` ≥ 1.9; `docker`.
- **[You]** Azure OpenAI access approved (done — DI + OpenAI already live in `rg-coa-dev`).
- **[You]** An **Entra admin** for the app registration + admin consent (steps 4 and 6).
- **[Done]** Fabric SQL operational DB exists; migrations 0001–0007 applied.

## 1. [You] Fill in dev coordinates
```bash
cd infra/terraform/envs/dev
cp terraform.tfvars.example terraform.tfvars
# Set: subscription_id, name_suffix, fabric_admin_members, ar_mailbox, ap_mailbox,
#      fabric_sql_server, fabric_sql_database, lakehouse_sql_server, lakehouse_sql_database
```
Fabric/Lakehouse endpoints are NOT secrets (Entra auth) — see the `fabric-sql-dev` note for the values.

## 2. [You] Provision / update infrastructure (no image yet)
```bash
terraform init && terraform apply           # image_tag defaults to "" → placeholder image, infra only
```
Creates (idempotently) the Container Apps env, ACR, Service Bus, Blob, Key Vault, managed identities,
and the role grants (Blob / Service Bus / Key Vault / ACR-pull / DI / OpenAI). `rg-coa-dev` already has
DI + OpenAI; this adds the rest. **Billable.**

## 3. [You] Create the Key Vault secrets
The API requires `GRAPH_CLIENT_STATE` (mailbox-subscription secret; any random value is fine when
relying on polling). AP adds `graph-client-state-ap`.
```bash
KV=$(terraform -chdir=infra/terraform/envs/dev output -raw key_vault_uri | sed -E 's#https://([^.]+).*#\1#')
az keyvault secret set --vault-name "$KV" --name graph-client-state    --value "$(openssl rand -hex 24)"
az keyvault secret set --vault-name "$KV" --name graph-client-state-ap --value "$(openssl rand -hex 24)"   # if ap_mailbox set
```

## 4. [You, admin] Register the Entra app for Easy Auth
1. Create an app registration (or reuse one). Add a **Web** redirect URI:
   `https://<web-fqdn>/.auth/login/aad/callback` (web-fqdn appears in `terraform output app_fqdns` after step 7; you can add it then and re-run step 6).
2. Define **App Roles** (`Administrator`, `OrderProcessor`, `Supervisor`, `Viewer`) and **grant admin consent**.
   (Alternatively map Entra groups → roles via `EASY_AUTH_ROLE_MAP` on the API — `groupObjectId=Role,...`.)

## 5. [You/Claude] Build + push images and deploy
```bash
bash scripts/deploy-dev.sh      # builds web+api+workers, pushes to ACR, then `terraform apply -var image_tag=<sha>`
```
Claude can build + push the images (docker + az are available in-session); `terraform apply` is yours.
This rolls web/api/workers/poll to the real images with all env + Key Vault secret refs wired.

## 6. [You] Enable Easy Auth on the web app
```bash
RG=$(terraform -chdir=infra/terraform/envs/dev output -raw resource_group)
az containerapp auth microsoft update -g "$RG" -n ca-coa-dev-web \
  --client-id <appId> --client-secret-name microsoft-provider-authentication-secret \
  --tenant-id <tenantId> --yes
az containerapp auth update -g "$RG" -n ca-coa-dev-web \
  --unauthenticated-client-action RedirectToLoginPage
```
Now every request to the web app requires an Entra sign-in; the identity is forwarded to the internal API.

## 7. [You, admin] Connect the mailboxes for polling
Grant the **workers' managed identity** the Graph `Mail.Read` **application** permission, admin-consent,
and scope it to just the AR/AP mailboxes (least privilege, spec §3):
```powershell
New-ApplicationAccessPolicy -AppId <workersClientId> -PolicyScopeGroupId orders@lyonsmagnus.com `
  -AccessRight RestrictAccess -Description "AR order mailbox only"
New-ApplicationAccessPolicy -AppId <workersClientId> -PolicyScopeGroupId invoices@lyonsmagnus.com `
  -AccessRight RestrictAccess -Description "AP invoice mailbox only"
```
The poll job (every 5 min) then delta-queries both mailboxes and enqueues new messages. No webhook or
public endpoint is required. (See `ap-ingestion.md` for the no-loss cursor guarantee.)

## 8. [You/Claude] Smoke test
- Browse `https://<web-fqdn>` → you're redirected to Entra sign-in → the reviewer loads.
- **Upload** a test PO / invoice PDF → it processes through real DI + OpenAI → appears in the queue.
- Email a PO to the AR mailbox → within ~5 min the poll job ingests it → it appears in the queue.
- AI clients in isolation (optional): `tests/e2e/azure-di.test.ts`, `azure-foundry.test.ts` (live-gated).

## 9. [You] Give testers access
Assign tester users to the App Roles (step 4) in Entra. Send them `https://<web-fqdn>`.

## Known gaps / hardening follow-ups
- Images run via `tsx` (not compiled/bundled) — a hardening follow-up.
- Graph change-notification webhook (push) is not wired for prod; polling is the supported path. If a
  push path is later added, the API must move behind Easy Auth with `/integration/graph/*` excluded.
- A custom PO **Document Intelligence** model (or confirm `prebuilt-invoice`) + data-retention review (§3).
