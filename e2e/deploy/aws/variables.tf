variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "prefix" {
  description = "Resource name prefix"
  type        = string
  default     = "infralift-e2e"
}

variable "db_password" {
  description = "Password for the RDS Postgres instance"
  type        = string
  sensitive   = true
}

variable "docker_image" {
  description = "Public Docker image for the demo app (ECR_PUBLIC format)"
  type        = string
  default     = "public.ecr.aws/docker/library/node:22-slim"
}
