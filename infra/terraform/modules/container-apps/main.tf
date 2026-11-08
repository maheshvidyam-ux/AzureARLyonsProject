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
    # target_port set => HTTP ingress is enabled on that port
    target_port = optional(number)
    external    = optional(bool, false)
  }))
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

  secret {
    name  = "appinsights-connection-string"
    value = var.app_insights_connection_string
  }

  template {
    min_replicas = 0
    max_replicas = 2

    container {
      name   = each.key
      image  = var.placeholder_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name        = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        secret_name = "appinsights-connection-string"
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

output "environment_id" { value = azurerm_container_app_environment.this.id }
output "app_fqdns" {
  value = { for k, v in azurerm_container_app.this : k => try(v.ingress[0].fqdn, null) }
}
