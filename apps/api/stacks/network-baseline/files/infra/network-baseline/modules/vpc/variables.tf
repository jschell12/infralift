variable "name" {
  type        = string
  description = "Prefix for every resource's Name tag."
}

variable "cidr" {
  type        = string
  description = "The VPC's address range. A /16 leaves room for 8 public and 8 private /20 subnets."

  validation {
    condition     = can(cidrhost(var.cidr, 0)) && tonumber(split("/", var.cidr)[1]) <= 20
    error_message = "cidr must be an IPv4 CIDR block of /20 or larger, such as 10.0.0.0/16."
  }
}

variable "az_count" {
  type        = number
  description = "How many availability zones to spread subnets across."

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat" {
  type        = bool
  description = "One NAT gateway for every zone (cheaper) instead of one per zone (survives a zone outage)."
}
