variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "db_password" {
  description = "Password for the Cloud SQL Postgres user"
  type        = string
  sensitive   = true
}

variable "docker_image" {
  description = "Docker image for the demo app"
  type        = string
  default     = "gcr.io/cloudrun/hello"
}
