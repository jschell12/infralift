output "site_url" {
  description = "Netlify site URL"
  value       = "https://${var.site_name}.netlify.app"
}

output "dns_zone_id" {
  description = "Netlify DNS zone ID"
  value       = netlify_dns_zone.zone.id
}
