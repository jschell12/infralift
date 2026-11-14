variable "name" {
  type        = string
  description = "Prefix for the distribution's helpers (origin access control, function)."
}

variable "domain" {
  type        = string
  description = "The site's host name, such as www.example.com."
}

variable "zone_name" {
  type        = string
  description = "The public Route 53 hosted zone the domain is in, such as example.com."
}

variable "price_class" {
  type        = string
  description = "Which CloudFront edge locations serve the site."

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "bucket" {
  type        = string
  description = "The site bucket's name."
}

variable "bucket_arn" {
  type = string
}

variable "bucket_regional_domain_name" {
  type = string
}
