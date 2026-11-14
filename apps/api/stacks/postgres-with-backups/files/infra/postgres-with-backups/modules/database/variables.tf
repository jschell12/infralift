variable "name" {
  type        = string
  description = "The instance identifier, and the prefix of everything that serves it."
}

variable "vpc_id" {
  type        = string
  description = "The VPC the database and its security group live in."
}

variable "subnet_ids" {
  type        = list(string)
  description = "Private subnets in at least two availability zones."

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS needs subnets in at least two availability zones."
  }
}

variable "allowed_cidr" {
  type        = string
  description = "The one CIDR allowed to connect on 5432. Empty means the VPC's own range."
}

variable "allowed_security_group_id" {
  type        = string
  description = "A security group whose members may also connect. Empty means none."
}

variable "instance_class" {
  type = string
}

variable "allocated_storage_gb" {
  type = number
}

variable "engine_version" {
  type        = string
  description = "A major version such as 17. RDS picks the minor version and upgrades it in the maintenance window."
}

variable "backup_retention_days" {
  type        = number
  description = "Days of automated backups kept for point-in-time restore."

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "RDS keeps automated backups for 1 to 35 days."
  }
}
