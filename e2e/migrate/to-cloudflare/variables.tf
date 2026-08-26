variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare DNS zone ID for the domain"
  type        = string
}

variable "domain" {
  description = "Base domain for DNS records (e.g. example.com)"
  type        = string
}

variable "neon_api_key" {
  description = "Neon API key for provisioning the database"
  type        = string
  sensitive   = true
}

variable "app_name" {
  description = "Application name used for resource naming"
  type        = string
  default     = "infralift-demo"
}
