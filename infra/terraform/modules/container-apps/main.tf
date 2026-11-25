variable "name_prefix" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "log_analytics_workspace_id" { type = string }
variable "infrastructure_subnet_id" {
  type    = string
  default = null # null => Container Apps-managed network (no custom VNet)
}
variable "app_insights_connection_string" {
  type      = string
  sensitive = true
}
variable "apps" {
  type = map(object({
    identity_id = string
    # image set => pull this image (from the ACR registry); null => the placeholder hello-world.
    image = optional(string)
    # target_port set => HTTP ingress is enabled on that port
    target_port = optional(number)
    external    = optional(bool, false)
    # Plain (non-secret) environment variables for the app's container. Entra auth means connection
    # coordinates (Service Bus namespace, mailboxes, queue names) are NOT secrets.
    env = optional(map(string), {})
    # Secret environment variables: ENV_NAME => Key Vault secret id. Each becomes a Container App
    # secret (pulled via the app's user-assigned identity) exposed to the container as ENV_NAME.
    secret_env = optional(map(string), {})
  }))
}
variable "jobs" {
  type = map(object({
    identity_id = string
    image       = optional(string)
    cron        = string                      # UNIX cron, e.g. "*/5 * * * *"
    command     = optional(list(string))      # container entrypoint override (e.g. the poll CLI)
    args        = optional(list(string))
    timeout     = optional(number, 600)        # replica_timeout_in_seconds
    env         = optional(map(string), {})
    secret_env  = optional(map(string), {})
  }))
  default     = {}
  description = "Scheduled (cron) Container App Jobs — e.g. the no-loss mailbox poll."
}
variable "registry_server" {
  type        = string
  default     = null
  description = "ACR login server (e.g. acrcoadev.azurecr.io). When set, apps/jobs pull images from it via their user-assigned identity (AcrPull)."
}
# Phase-1 placeholder: a public hello-world image so an authenticated, empty app deploys to
# dev (phase exit criterion). Real images move to ACR with a `registry {}` block in Phase 2.
variable "placeholder_image" {
  type    = string
  default = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_container_app_environment" "this" {
  name                       = "cae-${var.name_prefix}"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  log_analytics_workspace_id = var.log_analytics_workspace_id
  infrastructure_subnet_id   = var.infrastructure_subnet_id
  tags                       = var.tags
}

resource "azurerm_container_app" "this" {
  for_each                     = var.apps
  name                         = "ca-${var.name_prefix}-${each.key}"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [each.value.identity_id]
  }

  # Pull from ACR with the app's user-assigned identity (AcrPull). Only when a registry + a real
  # image are set; the placeholder hello-world image is public (no registry block needed).
  dynamic "registry" {
    for_each = (var.registry_server != null && each.value.image != null) ? [1] : []
    content {
      server   = var.registry_server
      identity = each.value.identity_id
    }
  }

  secret {
    name  = "appinsights-connection-string"
    value = var.app_insights_connection_string
  }

  # One Container App secret per secret_env entry, sourced from Key Vault via the app identity.
  dynamic "secret" {
    for_each = each.value.secret_env
    content {
      name                = lower(replace(secret.key, "_", "-"))
      key_vault_secret_id = secret.value
      identity            = each.value.identity_id
    }
  }

  template {
    min_replicas = 0
    max_replicas = 2

    container {
      name   = each.key
      image  = coalesce(each.value.image, var.placeholder_image)
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name        = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        secret_name = "appinsights-connection-string"
      }

      dynamic "env" {
        for_each = each.value.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = each.value.secret_env
        content {
          name        = env.key
          secret_name = lower(replace(env.key, "_", "-"))
        }
      }
    }
  }

  dynamic "ingress" {
    for_each = each.value.target_port == null ? [] : [each.value]
    content {
      external_enabled = ingress.value.external
      target_port      = ingress.value.target_port
      transport        = "auto"

      traffic_weight {
        latest_revision = true
        percentage      = 100
      }
    }
  }
}

resource "azurerm_container_app_job" "this" {
  for_each                     = var.jobs
  name                         = "caj-${var.name_prefix}-${each.key}"
  location                     = var.location
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.this.id

  replica_timeout_in_seconds = each.value.timeout
  replica_retry_limit        = 1

  schedule_trigger_config {
    cron_expression          = each.value.cron
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [each.value.identity_id]
  }

  dynamic "registry" {
    for_each = (var.registry_server != null && each.value.image != null) ? [1] : []
    content {
      server   = var.registry_server
      identity = each.value.identity_id
    }
  }

  secret {
    name  = "appinsights-connection-string"
    value = var.app_insights_connection_string
  }

  dynamic "secret" {
    for_each = each.value.secret_env
    content {
      name                = lower(replace(secret.key, "_", "-"))
      key_vault_secret_id = secret.value
      identity            = each.value.identity_id
    }
  }

  template {
    container {
      name    = each.key
      image   = coalesce(each.value.image, var.placeholder_image)
      cpu     = 0.25
      memory  = "0.5Gi"
      command = each.value.command
      args    = each.value.args

      env {
        name        = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        secret_name = "appinsights-connection-string"
      }
      dynamic "env" {
        for_each = each.value.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = each.value.secret_env
        content {
          name        = env.key
          secret_name = lower(replace(env.key, "_", "-"))
        }
      }
    }
  }

  tags = var.tags
}

output "environment_id" { value = azurerm_container_app_environment.this.id }
output "app_fqdns" {
  value = { for k, v in azurerm_container_app.this : k => try(v.ingress[0].fqdn, null) }
}
