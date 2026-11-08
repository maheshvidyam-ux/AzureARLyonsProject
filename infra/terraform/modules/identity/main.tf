variable "name_prefix" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "workloads" {
  type        = set(string)
  description = "Logical workloads that each get a user-assigned managed identity (api, workers, web)."
  default     = ["api", "workers", "web"]
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_user_assigned_identity" "this" {
  for_each            = var.workloads
  name                = "id-${var.name_prefix}-${each.key}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

output "identity_ids" {
  value = { for k, v in azurerm_user_assigned_identity.this : k => v.id }
}
output "principal_ids" {
  value = { for k, v in azurerm_user_assigned_identity.this : k => v.principal_id }
}
output "client_ids" {
  value = { for k, v in azurerm_user_assigned_identity.this : k => v.client_id }
}
