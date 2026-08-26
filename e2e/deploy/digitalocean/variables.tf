variable "region" {
  description = "DigitalOcean region slug"
  type        = string
  default     = "nyc1"
}

variable "do_token" {
  description = "DigitalOcean personal access token"
  type        = string
  sensitive   = true
}
