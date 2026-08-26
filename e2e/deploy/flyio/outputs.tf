output "app_url" {
  description = "Fly.io app URL"
  value       = "https://${fly_app.app.name}.fly.dev"
}
