variable "team_slug" {
  description = "Netlify team slug (found in your team URL)"
  type        = string
}

variable "site_name" {
  description = "Name of an existing Netlify site (create one manually first)"
  type        = string
  default     = "infralift-e2e"
}

variable "neon_database_url" {
  description = "Neon Postgres connection string (provisioned separately at neon.tech)"
  type        = string
  sensitive   = true
}
