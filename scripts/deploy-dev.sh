#!/usr/bin/env bash
# Build + push the api/workers images and point the dev Container Apps at them, wiring env from
# Terraform outputs. Run AFTER `terraform apply` (dev) and after the AI + Fabric SQL resources
# exist. Requires: az login, docker. Spec §18: dev only, review before prod.
set -euo pipefail

TF_DIR="infra/terraform/envs/dev"
RG="$(terraform -chdir=$TF_DIR output -raw resource_group)"
ACR="$(terraform -chdir=$TF_DIR output -raw acr_login_server)"              # acr....azurecr.io
BLOB="$(terraform -chdir=$TF_DIR output -raw blob_endpoint)"
DI="$(terraform -chdir=$TF_DIR output -raw doc_intelligence_endpoint)"
OAI="$(terraform -chdir=$TF_DIR output -raw openai_endpoint)"
DEP="$(terraform -chdir=$TF_DIR output -raw openai_deployment_name)"
SB_ENDPOINT="$(terraform -chdir=$TF_DIR output -raw servicebus_endpoint)"   # https://<ns>.servicebus.windows.net:443/
SB_NS="$(echo "$SB_ENDPOINT" | sed -E 's#https?://([^/:]+).*#\1#')"
TAG="${TAG:-$(git rev-parse --short HEAD)}"

# ---- values you must supply (not derivable from Terraform) ----
: "${MAILBOX:?set MAILBOX=orders@lyonsmagnus.com}"
: "${GRAPH_CLIENT_STATE:?set GRAPH_CLIENT_STATE=<subscription secret>}"
: "${FABRIC_SQL_SERVER:?set FABRIC_SQL_SERVER=<fabric sql endpoint>}"
: "${FABRIC_SQL_DATABASE:?set FABRIC_SQL_DATABASE=<fabric sql db name>}"

echo "→ building + pushing images to $ACR (tag $TAG)"
az acr login --name "${ACR%%.*}"
docker build -f apps/api/Dockerfile     -t "$ACR/coa-api:$TAG"     .
docker build -f apps/workers/Dockerfile -t "$ACR/coa-workers:$TAG" .
docker push "$ACR/coa-api:$TAG"
docker push "$ACR/coa-workers:$TAG"

echo "→ deploying api"
az containerapp update -g "$RG" -n "ca-coa-dev-api" --image "$ACR/coa-api:$TAG" \
  --set-env-vars PORT=8080 GRAPH_CLIENT_STATE="$GRAPH_CLIENT_STATE" SERVICEBUS_NAMESPACE="$SB_NS"

echo "→ deploying workers"
az containerapp update -g "$RG" -n "ca-coa-dev-workers" --image "$ACR/coa-workers:$TAG" \
  --set-env-vars MAILBOX="$MAILBOX" SERVICEBUS_NAMESPACE="$SB_NS" BLOB_ACCOUNT_URL="$BLOB" \
    FABRIC_SQL_SERVER="$FABRIC_SQL_SERVER" FABRIC_SQL_DATABASE="$FABRIC_SQL_DATABASE" \
    DOC_INTEL_ENDPOINT="$DI" AI_FOUNDRY_ENDPOINT="$OAI" AI_FOUNDRY_DEPLOYMENT="$DEP"

echo "✅ deployed api + workers at tag $TAG. Grant the apps' managed identities the data-plane"
echo "   roles (Cognitive Services User/OpenAI User, Storage Blob Data Contributor, Service Bus"
echo "   Sender/Receiver, Fabric SQL access, Graph Mail.Read) — see docs/runbooks/go-live.md."
