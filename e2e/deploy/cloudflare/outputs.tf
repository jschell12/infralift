output "worker_url" {
  description = "Cloudflare Workers URL"
  value       = "https://infralift-e2e.${var.account_id}.workers.dev"
}

output "r2_bucket" {
  description = "R2 bucket name"
  value       = cloudflare_r2_bucket.storage.name
}
