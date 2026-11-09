# Azure AI resources (spec §2, docs/06 rows 8-9): Document Intelligence + AI Foundry (Azure
# OpenAI) with a model deployment. Entra-only (local auth disabled); workload identities get the
# minimal data-plane roles. Consumed by the real DI/Foundry clients in apps/workers.

variable "name_prefix" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }

variable "di_name" { type = string }     # globally-unique; becomes the DI custom subdomain
variable "openai_name" { type = string } # globally-unique; becomes the OpenAI custom subdomain
variable "di_sku" {
  type    = string
  default = "S0"
}
variable "openai_sku" {
  type    = string
  default = "S0"
}
variable "openai_deployment_name" {
  type    = string
  default = "gpt-4o-po"
}
variable "openai_model" {
  type    = string
  default = "gpt-4o"
}
variable "openai_model_version" {
  type    = string
  default = "2024-08-06"
}
variable "openai_capacity" {
  type    = number
  default = 10
}
variable "reader_principal_ids" {
  type        = map(string)
  description = "Managed-identity principal ids granted the AI data-plane roles."
  default     = {}
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_cognitive_account" "di" {
  name                          = var.di_name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  kind                          = "FormRecognizer"
  sku_name                      = var.di_sku
  custom_subdomain_name         = var.di_name
  public_network_access_enabled = true # prod: private endpoint (docs/06)
  tags                          = var.tags
}

resource "azurerm_cognitive_account" "openai" {
  name                          = var.openai_name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  kind                          = "OpenAI"
  sku_name                      = var.openai_sku
  custom_subdomain_name         = var.openai_name
  public_network_access_enabled = true
  tags                          = var.tags
}

resource "azurerm_cognitive_deployment" "gpt" {
  name                 = var.openai_deployment_name
  cognitive_account_id = azurerm_cognitive_account.openai.id

  model {
    format  = "OpenAI"
    name    = var.openai_model
    version = var.openai_model_version
  }

  sku {
    name     = "Standard"
    capacity = var.openai_capacity
  }
}

resource "azurerm_role_assignment" "di_user" {
  for_each             = var.reader_principal_ids
  scope                = azurerm_cognitive_account.di.id
  role_definition_name = "Cognitive Services User"
  principal_id         = each.value
}

resource "azurerm_role_assignment" "openai_user" {
  for_each             = var.reader_principal_ids
  scope                = azurerm_cognitive_account.openai.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = each.value
}

output "doc_intelligence_endpoint" { value = azurerm_cognitive_account.di.endpoint }
output "openai_endpoint" { value = azurerm_cognitive_account.openai.endpoint }
output "openai_deployment_name" { value = azurerm_cognitive_deployment.gpt.name }
