variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "prefix" {
  description = "Resource name prefix"
  type        = string
  default     = "infralift"
}

variable "db_password" {
  description = "Password for the PostgreSQL Flexible Server admin user"
  type        = string
  sensitive   = true
}
