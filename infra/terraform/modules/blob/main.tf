variable "name" {
  type        = string
  description = "Storage account name (3-24 lowercase alphanumeric, globally unique)."
}
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "containers" {
  type    = set(string)
  default = ["originals", "ocr-raw"]
}
variable "blob_contributor_principal_ids" {
  type        = map(string)
  description = "Managed-identity principal ids granted Storage Blob Data Contributor."
  default     = {}
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_storage_account" "this" {
  name                            = var.name
  location                        = var.location
  resource_group_name             = var.resource_group_name
  account_tier                    = "Standard"
  account_replication_type        = "LRS" # prod: ZRS/GRS
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

resource "azurerm_storage_container" "this" {
  for_each              = var.containers
  name                  = each.key
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "blob_contributor" {
  for_each             = var.blob_contributor_principal_ids
  scope                = azurerm_storage_account.this.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
}

output "storage_account_id" { value = azurerm_storage_account.this.id }
output "primary_blob_endpoint" { value = azurerm_storage_account.this.primary_blob_endpoint }
