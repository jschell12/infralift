# Netlify connector test fixtures
#
# The Netlify Terraform provider manages config on existing sites (env vars,
# DNS, WAF) but cannot create sites. Create a site through the dashboard first,
# then use this config to add a DNS zone for the connector to discover.
#
# Prereqs:
#   1. Create a free site at app.netlify.com (click "Add new site" > "Deploy manually")
#   2. Note the site name (e.g. "infralift-test")
#
# Required env vars:
#   NETLIFY_API_TOKEN (personal access token from app.netlify.com)
#
# Cost: $0 (free tier)

terraform {
  required_version = ">= 1.5"
  required_providers {
    netlify = {
      source  = "netlify/netlify"
      version = "~> 0.4"
    }
  }
}

provider "netlify" {
  default_team_slug = var.team_slug
}

variable "team_slug" {
  description = "Netlify team slug (find it in your team URL)"
  type        = string
}

variable "site_name" {
  description = "Name of an existing Netlify site to manage"
  type        = string
  default     = "infralift-test"
}

# Reference existing site
data "netlify_site" "test" {
  name = var.site_name
}

# DNS zone (free — connector inventories netlify:dns_zone)
resource "netlify_dns_zone" "test" {
  name      = "infralift-test.example"
  team_slug = var.team_slug
}

# Environment variable on the site (connector inventories env var count)
resource "netlify_environment_variable" "test" {
  site_id = data.netlify_site.test.id
  key     = "INFRALIFT_TEST_VAR"
  values = [
    {
      value   = "test-value"
      context = "all"
    }
  ]
}

output "site_id" {
  value = data.netlify_site.test.id
}

output "dns_zone_id" {
  value = netlify_dns_zone.test.id
}
