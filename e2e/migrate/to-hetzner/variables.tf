variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key for VM access"
  type        = string
}

variable "domain" {
  description = "Domain name for the app (must point DNS to the server IP)"
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
