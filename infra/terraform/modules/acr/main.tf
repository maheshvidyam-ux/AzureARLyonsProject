variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "sku" {
  type    = string
  default = "Basic" # dev; prod uses Premium (private endpoints, geo-replication)
}
variable "acrpull_principal_ids" {
  type        = map(string)
  description = "Managed-identity principal ids that get AcrPull."
  default     = {}
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_container_registry" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = var.sku
  admin_enabled       = false # managed-identity pull only (spec §3)
  tags                = var.tags
}

resource "azurerm_role_assignment" "acrpull" {
  for_each             = var.acrpull_principal_ids
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = each.value
}

output "login_server" { value = azurerm_container_registry.this.login_server }
output "acr_id" { value = azurerm_container_registry.this.id }
