variable "region" {
  description = "Fly.io region code"
  type        = string
  default     = "iad"
}

variable "org" {
  description = "Fly.io organization slug"
  type        = string
  default     = "personal"
}

variable "app_name" {
  description = "Fly app name (must be globally unique)"
  type        = string
  default     = "infralift-e2e"
}

variable "docker_image" {
  description = "Docker image for the demo app"
  type        = string
  default     = "nginx:alpine"
}

variable "neon_database_url" {
  description = "Neon Postgres connection string (provisioned separately at neon.tech)"
  type        = string
  sensitive   = true
}
