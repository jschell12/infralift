output "app_url" {
  description = "App Platform live URL"
  value       = digitalocean_app.app.live_url
}

output "database_url" {
  description = "Managed Postgres connection string"
  value       = digitalocean_database_cluster.postgres.uri
  sensitive   = true
}

output "spaces_endpoint" {
  description = "Spaces bucket endpoint"
  value       = "https://${digitalocean_spaces_bucket.storage.bucket_domain_name}"
}
