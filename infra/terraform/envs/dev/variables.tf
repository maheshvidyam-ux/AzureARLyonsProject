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
