variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "sku" {
  type    = string
  default = "Standard" # prod: Premium (VNet + throughput)
}
variable "queues" {
  type        = set(string)
  description = "Durable work queues; each gets dead-lettering on expiry."
  default     = ["ingestion", "extraction", "interpretation", "validation", "publishing"]
}
variable "sender_receiver_principal_ids" {
  type        = map(string)
  description = "Managed-identity principal ids granted Service Bus Data Sender+Receiver."
  default     = {}
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_servicebus_namespace" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = var.sku
  tags                = var.tags
}

resource "azurerm_servicebus_queue" "this" {
  for_each                             = var.queues
  name                                 = each.key
  namespace_id                         = azurerm_servicebus_namespace.this.id
  dead_lettering_on_message_expiration = true
  max_delivery_count                   = 10
  default_message_ttl                  = "P14D"
}

resource "azurerm_role_assignment" "sender" {
  for_each             = var.sender_receiver_principal_ids
  scope                = azurerm_servicebus_namespace.this.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = each.value
}

resource "azurerm_role_assignment" "receiver" {
  for_each             = var.sender_receiver_principal_ids
  scope                = azurerm_servicebus_namespace.this.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = each.value
}

output "namespace_id" { value = azurerm_servicebus_namespace.this.id }
output "namespace_endpoint" { value = azurerm_servicebus_namespace.this.endpoint }
