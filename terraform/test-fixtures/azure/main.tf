# Azure connector test fixtures
#
# Provisions an App Service (free tier), storage account, and resource group.
# All within the free tier or the $200 trial credit for new accounts.
#
# Required env vars:
#   ARM_SUBSCRIPTION_ID, ARM_TENANT_ID, ARM_CLIENT_ID, ARM_CLIENT_SECRET
#   - or - az login
#
# Cost: $0 (App Service Free tier: F1; Storage: 5GB LRS free for 12 months)

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "location" {
  default = "eastus"
}

variable "prefix" {
  default = "infralift"
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name = "${var.prefix}${random_id.suffix.hex}"
}

# Resource group
resource "azurerm_resource_group" "test" {
  name     = "${var.prefix}-test-rg"
  location = var.location

  tags = {
    Project   = "infralift-test"
    ManagedBy = "terraform"
  }
}

# App Service Plan (Free tier F1)
resource "azurerm_service_plan" "test" {
  name                = "${local.name}-plan"
  location            = azurerm_resource_group.test.location
  resource_group_name = azurerm_resource_group.test.name
  os_type             = "Linux"
  sku_name            = "F1"
}

# App Service (Free tier)
resource "azurerm_linux_web_app" "test" {
  name                = "${local.name}-app"
  location            = azurerm_resource_group.test.location
  resource_group_name = azurerm_resource_group.test.name
  service_plan_id     = azurerm_service_plan.test.id

  site_config {
    application_stack {
      node_version = "20-lts"
    }
  }

  tags = {
    Project   = "infralift-test"
    ManagedBy = "terraform"
  }
}

# Storage account (5GB LRS free for 12 months on new accounts)
resource "azurerm_storage_account" "test" {
  name                     = "${local.name}st"
  resource_group_name      = azurerm_resource_group.test.name
  location                 = azurerm_resource_group.test.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  tags = {
    Project   = "infralift-test"
    ManagedBy = "terraform"
  }
}

# Service principal for the infralift connector
data "azurerm_subscription" "current" {}

output "app_service_url" {
  value = "https://${azurerm_linux_web_app.test.default_hostname}"
}

output "storage_account_name" {
  value = azurerm_storage_account.test.name
}

output "resource_group" {
  value = azurerm_resource_group.test.name
}
