# Operational source of truth = SQL database in Fabric (ADR 0007, supersedes PostgreSQL).
# Provisions: Fabric capacity (azurerm) -> Fabric workspace -> SQL database (fabric provider).

terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm" }
    fabric  = { source = "microsoft/fabric" }
  }
}

variable "capacity_name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "sku_name" {
  type    = string
  default = "F2" # smallest Fabric SKU; prod sizes up and sets a no-pause policy (ADR 0007 follow-up #1)
}
variable "admin_members" {
  type        = list(string)
  description = "Fabric capacity administrators (UPNs or service-principal object ids)."
}
variable "workspace_display_name" { type = string }
variable "database_display_name" {
  type    = string
  default = "coa-operational"
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_fabric_capacity" "this" {
  name                   = var.capacity_name
  resource_group_name    = var.resource_group_name
  location               = var.location
  administration_members = var.admin_members

  sku {
    name = var.sku_name
    tier = "Fabric"
  }

  tags = var.tags
}

# The Fabric control-plane capacity id (GUID) differs from the ARM resource id.
data "fabric_capacity" "this" {
  display_name = azurerm_fabric_capacity.this.name
}

resource "fabric_workspace" "this" {
  display_name = var.workspace_display_name
  capacity_id  = data.fabric_capacity.this.id
  description  = "Customer Order Automation operational workspace (ADR 0007)."
}

# SQL database in Fabric — transactional OLTP operational store. Apply db/migrations against it.
resource "fabric_sql_database" "this" {
  display_name = var.database_display_name
  workspace_id = fabric_workspace.this.id
  description  = "Operational source of truth: orders, validation, duplicate claims, audit."
}

output "capacity_arm_id" { value = azurerm_fabric_capacity.this.id }
output "workspace_id" { value = fabric_workspace.this.id }
output "sql_database_id" { value = fabric_sql_database.this.id }
