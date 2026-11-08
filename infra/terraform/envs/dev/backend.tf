# Remote state (recommended before any shared use). Uncomment and fill in once a dedicated
# state storage account exists. Until then Terraform uses local state (do NOT commit it).
#
# terraform {
#   backend "azurerm" {
#     resource_group_name  = "rg-coa-tfstate"
#     storage_account_name = "stcoatfstate<suffix>"
#     container_name       = "tfstate"
#     key                  = "dev.terraform.tfstate"
#     use_azuread_auth     = true
#   }
# }
