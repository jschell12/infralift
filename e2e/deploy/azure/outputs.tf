output "app_url" {
  description = "App Service URL"
  value       = "https://${azurerm_linux_web_app.app.default_hostname}"
}

output "database_url" {
  description = "Postgres connection string"
  value       = "postgresql://infralift:${var.db_password}@${azurerm_postgresql_flexible_server.postgres.fqdn}:5432/infralift?sslmode=require"
  sensitive   = true
}

output "storage_account_name" {
  description = "Azure Storage Account name"
  value       = azurerm_storage_account.storage.name
}
