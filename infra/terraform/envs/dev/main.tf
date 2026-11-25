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

  apps = {
    web = { identity_id = module.identity.identity_ids["web"], target_port = 80, external = true }
    # API hosts the Graph notification webhook: it publishes AR message ids to `ingestion` and
    # AP message ids to `ingestion-ap` (routing is by the subscription's clientState).
    api = {
      identity_id = module.identity.identity_ids["api"]
      target_port = 80
      external    = true
      env = {
        SERVICEBUS_NAMESPACE    = module.servicebus.namespace_endpoint
        INGESTION_QUEUE_NAME    = "ingestion"
        AP_INGESTION_QUEUE_NAME = "ingestion-ap"
      }
    }
    # Workers run the AR order pipeline (ingestion queue + MAILBOX) and, when AP_MAILBOX is set,
    # the AP invoice pipeline on the ingestion-ap queue. Secrets + the Fabric/AI/Lakehouse
    # coordinates are injected the same way (Key Vault secret refs) alongside these when real
    # images are wired — they are intentionally omitted from the Phase-1 placeholder deploy.
    workers = {
      identity_id = module.identity.identity_ids["workers"]
      env         = local.worker_env
    }
  }

  # Scheduled no-loss mailbox poll (delta-query cursor) — the primary ingestion mechanism. Enqueues
  # new message ids to ingestion / ingestion-ap for the workers to process. Placeholder command runs
  # cleanly on the hello-world image; the real image overrides it with the poll CLI (Phase 2).
  jobs = {
    poll = {
      identity_id = module.identity.identity_ids["workers"]
      cron        = "*/5 * * * *"
      command     = ["/bin/sh", "-c", "echo 'mailbox poll placeholder — real image runs: node apps/workers/src/ingestion/poll-cli.js'; exit 0"]
      env         = local.worker_env
    }
  }

  tags = local.tags
}
