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

variable "image_tag" {
  type        = string
  description = "Container image tag to deploy for web/api/workers (e.g. a git sha). Empty = placeholder hello-world image (no app deployed yet)."
  default     = ""
}

# Operational store (SQL database in Fabric) — the reviewer/upload DB. Entra auth (no secret);
# these connection coordinates are supplied as variables because the Fabric SQL endpoint is not a
# Terraform attribute of the capacity. See the fabric-sql-dev memory for the dev values.
variable "fabric_sql_server" {
  type        = string
  description = "Fabric SQL server FQDN for the operational DB (mssql, Entra auth)."
  default     = ""
}
variable "fabric_sql_database" {
  type        = string
  description = "Fabric SQL database name for the operational DB."
  default     = ""
}

# ERP validation masters (Fabric Lakehouse SQL endpoint). Empty = matching deferred, AP uploads off.
variable "lakehouse_sql_server" {
  type        = string
  description = "Fabric Lakehouse SQL endpoint FQDN for ERP master/PO reads. Empty disables matching."
  default     = ""
}
variable "lakehouse_sql_database" {
  type        = string
  description = "Fabric Lakehouse SQL database (the gold warehouse) name."
  default     = ""
}

# Optional override for the invoice interpretation deployment (defaults to the shared OpenAI deployment).
variable "ai_foundry_invoice_deployment" {
  type        = string
  description = "AI Foundry deployment for invoice interpretation. Empty = reuse the shared order deployment."
  default     = ""
}
