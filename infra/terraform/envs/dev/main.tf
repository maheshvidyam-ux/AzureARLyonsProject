# Dev environment for Customer Order Automation (spec §15, docs/06). Isolated resource group
# and identity boundary. Operational store = SQL database in Fabric (ADR 0007).
#
# GUARDRAIL (spec §18): dev only. No production mailbox, no AX writes, no prod data. Apply is
# PR-gated via `terraform plan`; no unreviewed infra deploys.

data "azurerm_client_config" "current" {}

locals {
  name_prefix = "coa-${var.environment}" # hyphenated names
  compact     = "coa${var.environment}"  # names that disallow hyphens
  tags = {
    project     = "customer-order-automation"
    environment = var.environment
    managed_by  = "terraform"
  }

  # Workloads that touch Service Bus + Blob (web is UI-only).
  worker_principals = {
    for k, v in module.identity.principal_ids : k => v if contains(["api", "workers"], k)
  }

  # Env shared by the workers app (queue consumers) and the scheduled poll job (queue producer).
  worker_env = merge(
    {
      SERVICEBUS_NAMESPACE    = module.servicebus.namespace_endpoint
      INGESTION_QUEUE_NAME    = "ingestion"
      AP_INGESTION_QUEUE_NAME = "ingestion-ap"
    },
    var.ar_mailbox == "" ? {} : { MAILBOX = var.ar_mailbox },
    var.ap_mailbox == "" ? {} : { AP_MAILBOX = var.ap_mailbox },
  )

  # Real images from ACR when image_tag is set; otherwise null => the placeholder hello-world image
  # (so `terraform apply` succeeds before any image is pushed — Phase-1 behaviour is preserved).
  deploy_images = var.image_tag == "" ? { web = null, api = null, workers = null } : {
    web     = "${module.acr.login_server}/coa-web:${var.image_tag}"
    api     = "${module.acr.login_server}/coa-api:${var.image_tag}"
    workers = "${module.acr.login_server}/coa-workers:${var.image_tag}"
  }

  # Non-secret connection coordinates shared by api + workers (Entra auth → NOT secrets). Fabric SQL
  # + Lakehouse endpoints are variables because they are not Terraform attributes of the capacity.
  app_coordinates = merge(
    {
      BLOB_ACCOUNT_URL      = module.blob.primary_blob_endpoint
      DOC_INTEL_ENDPOINT    = module.ai.doc_intelligence_endpoint
      AI_FOUNDRY_ENDPOINT   = module.ai.openai_endpoint
      AI_FOUNDRY_DEPLOYMENT = module.ai.openai_deployment_name
    },
    var.fabric_sql_server == "" ? {} : { FABRIC_SQL_SERVER = var.fabric_sql_server },
    var.fabric_sql_database == "" ? {} : { FABRIC_SQL_DATABASE = var.fabric_sql_database },
    var.lakehouse_sql_server == "" ? {} : { LAKEHOUSE_SQL_SERVER = var.lakehouse_sql_server },
    var.lakehouse_sql_database == "" ? {} : { LAKEHOUSE_SQL_DATABASE = var.lakehouse_sql_database },
    var.ai_foundry_invoice_deployment == "" ? {} : { AI_FOUNDRY_INVOICE_DEPLOYMENT = var.ai_foundry_invoice_deployment },
  )

  # GRAPH_CLIENT_STATE secret(s) live in Key Vault (set out-of-band: `az keyvault secret set`).
  # Versionless ids so rotation flows through without a redeploy.
  graph_secret_env = merge(
    { GRAPH_CLIENT_STATE = "${module.keyvault.key_vault_uri}secrets/graph-client-state" },
    var.ap_mailbox == "" ? {} : { GRAPH_CLIENT_STATE_AP = "${module.keyvault.key_vault_uri}secrets/graph-client-state-ap" },
  )

  # Internal URL the public web app's nginx proxies /api → (same Container Apps environment).
  api_internal_url = "http://ca-${local.name_prefix}-api"
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.name_prefix}"
  location = var.location
  tags     = local.tags
}

module "identity" {
  source              = "../../modules/identity"
  name_prefix         = local.name_prefix
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

module "monitor" {
  source              = "../../modules/monitor"
  name_prefix         = local.name_prefix
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

module "network" {
  source              = "../../modules/network"
  name_prefix         = local.name_prefix
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

module "keyvault" {
  source                     = "../../modules/keyvault"
  name                       = "kv-${local.name_prefix}-${var.name_suffix}"
  location                   = var.location
  resource_group_name        = azurerm_resource_group.this.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  secrets_user_principal_ids = module.identity.principal_ids
  tags                       = local.tags
}

module "acr" {
  source                = "../../modules/acr"
  name                  = "acr${local.compact}${var.name_suffix}"
  location              = var.location
  resource_group_name   = azurerm_resource_group.this.name
  acrpull_principal_ids = module.identity.principal_ids
  tags                  = local.tags
}

module "servicebus" {
  source                        = "../../modules/servicebus"
  name                          = "sb-${local.name_prefix}-${var.name_suffix}"
  location                      = var.location
  resource_group_name           = azurerm_resource_group.this.name
  sender_receiver_principal_ids = local.worker_principals
  tags                          = local.tags
}

module "blob" {
  source                         = "../../modules/blob"
  name                           = "st${local.compact}${var.name_suffix}"
  location                       = var.location
  resource_group_name            = azurerm_resource_group.this.name
  blob_contributor_principal_ids = local.worker_principals
  tags                           = local.tags
}

module "fabric_sqldb" {
  source                 = "../../modules/fabric-sqldb"
  capacity_name          = "fab${local.compact}${var.name_suffix}"
  location               = var.location
  resource_group_name    = azurerm_resource_group.this.name
  admin_members          = var.fabric_admin_members
  workspace_display_name = "Customer Order Automation (${var.environment})"
  tags                   = local.tags
}

module "ai" {
  source               = "../../modules/ai"
  name_prefix          = local.name_prefix
  location             = var.location
  resource_group_name  = azurerm_resource_group.this.name
  di_name              = "di${local.compact}${var.name_suffix}"
  openai_name          = "oai${local.compact}${var.name_suffix}"
  reader_principal_ids = local.worker_principals
  tags                 = local.tags
}

module "container_apps" {
  source                         = "../../modules/container-apps"
  name_prefix                    = local.name_prefix
  location                       = var.location
  resource_group_name            = azurerm_resource_group.this.name
  log_analytics_workspace_id     = module.monitor.log_analytics_workspace_id
  infrastructure_subnet_id       = module.network.apps_subnet_id
  app_insights_connection_string = module.monitor.app_insights_connection_string

  # Pull real images from ACR via managed identity once image_tag is set.
  registry_server = var.image_tag == "" ? null : module.acr.login_server

  apps = {
    # Public entry: serves the SPA + Entra Easy Auth, reverse-proxies /api to the internal API.
    web = {
      identity_id = module.identity.identity_ids["web"]
      image       = local.deploy_images.web
      target_port = 8080
      external    = true
      env         = { API_UPSTREAM = local.api_internal_url }
    }
    # Reviewer/upload/settings API — INTERNAL ingress only. It trusts the Easy Auth identity header
    # forwarded by the web app, so it must not be publicly reachable. Ingestion is via the poll job
    # (polling is primary), so no public Graph webhook is required.
    api = {
      identity_id = module.identity.identity_ids["api"]
      image       = local.deploy_images.api
      target_port = 8080
      external    = false
      env = merge(local.app_coordinates, {
        SERVICEBUS_NAMESPACE    = module.servicebus.namespace_endpoint
        INGESTION_QUEUE_NAME    = "ingestion"
        AP_INGESTION_QUEUE_NAME = "ingestion-ap"
      })
      secret_env = local.graph_secret_env
    }
    # Workers run the AR order pipeline (ingestion queue + MAILBOX) and, when AP_MAILBOX is set,
    # the AP invoice pipeline on the ingestion-ap queue, against the live Fabric/AI/Lakehouse coords.
    workers = {
      identity_id = module.identity.identity_ids["workers"]
      image       = local.deploy_images.workers
      env         = merge(local.worker_env, local.app_coordinates)
    }
  }

  # Scheduled no-loss mailbox poll (delta-query cursor) — the primary ingestion mechanism. Enqueues
  # new message ids to ingestion / ingestion-ap for the workers to process. With a placeholder image
  # it echoes; with the real workers image it runs the poll CLI.
  jobs = {
    poll = {
      identity_id = module.identity.identity_ids["workers"]
      image       = local.deploy_images.workers
      cron        = "*/5 * * * *"
      command = var.image_tag == "" ? ["/bin/sh", "-c", "echo 'mailbox poll placeholder — real image runs the poll CLI'; exit 0"] : [
        "npx", "tsx", "apps/workers/src/ingestion/poll-cli.ts"
      ]
      env = merge(local.worker_env, local.app_coordinates)
    }
  }

  tags = local.tags
}
