variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "tenant_id" { type = string }
variable "purge_protection_enabled" {
  type    = bool
  default = false # dev; prod overrides to true
}
variable "secrets_user_principal_ids" {
  type        = map(string)
  description = "Managed-identity principal ids that get Key Vault Secrets User (RBAC)."
  default     = {}
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_key_vault" "this" {
  name                       = var.name
  location                   = var.location
  resource_group_name        = var.resource_group_name
  tenant_id                  = var.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true # no access policies; RBAC only (spec §3)
  purge_protection_enabled   = var.purge_protection_enabled
  tags                       = var.tags
}

resource "azurerm_role_assignment" "secrets_user" {
  for_each             = var.secrets_user_principal_ids
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = each.value
}

output "key_vault_id" { value = azurerm_key_vault.this.id }
output "key_vault_uri" { value = azurerm_key_vault.this.vault_uri }
