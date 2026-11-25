#!/usr/bin/env bash
# Build + push the web/api/workers images to ACR, then `terraform apply` with that image tag so the
# dev Container Apps roll to the new revision with all env/secret wiring from Terraform.
#
# Run AFTER the infra exists (terraform apply once with no image_tag provisions ACR + everything
# else) and after the Key Vault secrets + Entra Easy Auth are configured (see
# docs/runbooks/go-live.md). Requires: az login, docker, terraform. Spec §18: dev only.
set -euo pipefail

TF_DIR="infra/terraform/envs/dev"
ACR="$(terraform -chdir=$TF_DIR output -raw acr_login_server)" # acr....azurecr.io
TAG="${TAG:-$(git rev-parse --short HEAD)}"

echo "→ building + pushing web/api/workers images to $ACR (tag $TAG)"
az acr login --name "${ACR%%.*}"
docker build -f apps/web/Dockerfile     -t "$ACR/coa-web:$TAG"     .
docker build -f apps/api/Dockerfile     -t "$ACR/coa-api:$TAG"     .
docker build -f apps/workers/Dockerfile -t "$ACR/coa-workers:$TAG" .
docker push "$ACR/coa-web:$TAG"
docker push "$ACR/coa-api:$TAG"
docker push "$ACR/coa-workers:$TAG"

echo "→ terraform apply with image_tag=$TAG (rolls all apps + the poll job to the new images)"
echo "  NOTE: Fabric/Lakehouse coordinates come from terraform.tfvars (see .example). The"
echo "  GRAPH_CLIENT_STATE secret must exist in Key Vault BEFORE apply (go-live.md step 3)."
terraform -chdir="$TF_DIR" apply -var="image_tag=$TAG"

echo "✅ deployed web + api + workers + poll job at tag $TAG."
echo "   App URL: $(terraform -chdir=$TF_DIR output -json app_fqdns | sed -n 's/.*\"web\":\"\([^\"]*\)\".*/https:\/\/\1/p')"
echo "   Next: configure Entra Easy Auth on the web app if not already (go-live.md step 4)."
