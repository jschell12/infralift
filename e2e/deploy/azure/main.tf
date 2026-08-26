# Azure E2E deployment for infralift-demo
#
# Provisions a Resource Group, App Service Plan (F1 free), Linux Web App (Node 22),
# Azure Database for PostgreSQL Flexible Server (Burstable B1ms), and a Storage
# Account with a Blob container.
#
# Prerequisites:
#   - Azure CLI: az login (or service principal env vars)
#   - Subscription with resource providers registered:
#     Microsoft.Web, Microsoft.DBforPostgreSQL, Microsoft.Storage
#
# Required env vars:
#   ARM_SUBSCRIPTION_ID, ARM_TENANT_ID, ARM_CLIENT_ID, ARM_CLIENT_SECRET
#   - or - az login
#   TF_VAR_subscription_id, TF_VAR_db_password
#
# Cost estimate:
#   App Service F1: $0 (free tier)
#   PostgreSQL Flexible B1ms: ~$13/mo
#   Storage Account LRS: ~$0 (5GB free for 12 months)
#   Total: ~$13/mo

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

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name = "${var.prefix}${random_id.suffix.hex}"
}

# ---------- Resource Group ----------

resource "azurerm_resource_group" "main" {
  name     = "${var.prefix}-e2e-rg"
  location = var.location

  tags = {
    Project   = "infralift-e2e"
    ManagedBy = "terraform"
  }
}

# ---------- PostgreSQL Flexible Server ----------

resource "azurerm_postgresql_flexible_server" "postgres" {
  name                          = "${local.name}-pg"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  administrator_login           = "infralift"
  administrator_password        = var.db_password
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = true

  tags = {
    Project   = "infralift-e2e"
    ManagedBy = "terraform"
  }
}

# Allow Azure services to connect
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.postgres.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# Allow all IPs for demo (restrict in production)
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_all" {
  name             = "AllowAll"
  server_id        = azurerm_postgresql_flexible_server.postgres.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "255.255.255.255"
}

resource "azurerm_postgresql_flexible_server_database" "infralift" {
  name      = "infralift"
  server_id = azurerm_postgresql_flexible_server.postgres.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# ---------- App Service ----------

resource "azurerm_service_plan" "main" {
  name                = "${local.name}-plan"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = "F1"

  tags = {
    Project   = "infralift-e2e"
    ManagedBy = "terraform"
  }
}

resource "azurerm_linux_web_app" "app" {
  name                = "${local.name}-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  service_plan_id     = azurerm_service_plan.main.id

  site_config {
    application_stack {
      node_version = "22-lts"
    }
    always_on = false # F1 tier does not support always_on
  }

  app_settings = {
    DATABASE_URL    = "postgresql://infralift:${var.db_password}@${azurerm_postgresql_flexible_server.postgres.fqdn}:5432/infralift?sslmode=require"
    PROVIDER_NAME   = "azure"
    STORAGE_BUCKET  = azurerm_storage_container.uploads.name
    WEBSITES_PORT   = "3000"
  }

  tags = {
    Project   = "infralift-e2e"
    ManagedBy = "terraform"
  }
}

# ---------- Storage Account ----------

resource "azurerm_storage_account" "storage" {
  name                     = "${local.name}st"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  tags = {
    Project   = "infralift-e2e"
    ManagedBy = "terraform"
  }
}

resource "azurerm_storage_container" "uploads" {
  name                  = "uploads"
  storage_account_id    = azurerm_storage_account.storage.id
  container_access_type = "private"
}
