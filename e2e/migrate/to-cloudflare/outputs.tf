output "worker_url" {
  description = "Cloudflare Workers URL for the deployed app"
  value       = "https://${var.app_name}.${var.domain}"
}

output "r2_bucket" {
  description = "R2 bucket name for object storage"
  value       = cloudflare_r2_bucket.storage.name
}

output "neon_database_url" {
  description = "Neon Postgres connection string"
  value       = "postgresql://${neon_project.app.database_user}:${neon_project.app.database_password}@${neon_project.app.database_host}/${neon_database.app.name}?sslmode=require"
  sensitive   = true
}

output "neon_host" {
  description = "Neon Postgres hostname"
  value       = neon_project.app.database_host
}
