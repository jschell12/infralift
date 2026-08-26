variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "neon_database_url" {
  description = "Neon Postgres connection string (provisioned separately at neon.tech)"
  type        = string
  sensitive   = true
}
