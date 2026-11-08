terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    fabric = {
      source  = "microsoft/fabric"
      version = "~> 1.0"
    }
  }

  # Remote state — see backend.tf (kept commented until a state storage account exists).
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

provider "fabric" {
  # Authenticates via Azure CLI / environment by default (no secrets in config).
}
