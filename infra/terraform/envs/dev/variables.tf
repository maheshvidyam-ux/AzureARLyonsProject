variable "subscription_id" {
  type        = string
  description = "Target Azure subscription id (dev)."
}

variable "location" {
  type    = string
  default = "eastus"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "name_suffix" {
  type        = string
  description = "Short lowercase-alphanumeric token (3-6 chars) to make globally-unique names unique."
}

variable "fabric_admin_members" {
  type        = list(string)
  description = "Fabric capacity administrators (UPNs or service-principal object ids)."
}

variable "ar_mailbox" {
  type        = string
  description = "AR customer-order mailbox the worker polls (e.g. orders@lyonsmagnus.com). Empty = not wired yet."
  default     = ""
}

variable "ap_mailbox" {
  type        = string
  description = "AP vendor-invoice mailbox the worker polls (e.g. invoices@lyonsmagnus.com). Empty = AP ingestion disabled."
  default     = ""
}
