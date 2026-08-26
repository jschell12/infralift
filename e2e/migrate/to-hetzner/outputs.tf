output "server_ip" {
  description = "Public IPv4 address of the Hetzner server"
  value       = hcloud_server.app.ipv4_address
}

output "neon_database_url" {
  description = "Neon Postgres connection string"
  value       = local.database_url
  sensitive   = true
}

output "app_url" {
  description = "Application URL (HTTPS via Caddy)"
  value       = "https://${var.domain}"
}
