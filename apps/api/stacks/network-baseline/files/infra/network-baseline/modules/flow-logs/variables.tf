variable "name" {
  type        = string
  description = "Prefix for the log group, role and flow log."
}

variable "vpc_id" {
  type        = string
  description = "The VPC whose traffic is logged."
}

variable "retention_days" {
  type        = number
  description = "Days CloudWatch keeps flow log records before deleting them."

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.retention_days)
    error_message = "retention_days must be a value CloudWatch Logs accepts, such as 7, 14, 30, 90 or 365."
  }
}
