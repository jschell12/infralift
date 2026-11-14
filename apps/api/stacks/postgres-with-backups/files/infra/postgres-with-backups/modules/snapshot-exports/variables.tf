variable "name" {
  type        = string
  description = "Prefix for the bucket, key alias and role."
}

variable "transition_days" {
  type        = number
  description = "Days before an export moves to Glacier Instant Retrieval."
  default     = 30
}

variable "retention_days" {
  type        = number
  description = "Days before an export is deleted."

  validation {
    condition     = var.retention_days > var.transition_days
    error_message = "retention_days must be longer than transition_days (30)."
  }
}
