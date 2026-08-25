# Cloudflare connector test fixtures
#
# Provisions a Worker, R2 bucket, and uses an existing zone. All free-tier.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN (with Workers/R2/Zone read+write)
#
# Cost: $0 (Workers free: 100k req/day; R2 free: 10GB storage)

terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
  }
}

provider "cloudflare" {}

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "zone_name" {
  description = "An existing DNS zone name (e.g. example.com)"
  type        = string
  default     = ""
}

# R2 bucket (free tier: 10GB storage, 1M Class A ops)
resource "cloudflare_r2_bucket" "test" {
  account_id = var.account_id
  name       = "infralift-test"
}

# Worker script (free tier: 100k req/day)
resource "cloudflare_workers_script" "test" {
  account_id = var.account_id
  script_name = "infralift-test-worker"

  main_module        = "worker.js"
  content            = "export default { fetch() { return new Response('ok'); } };"
  compatibility_date = "2024-01-01"
}

output "r2_bucket" {
  value = cloudflare_r2_bucket.test.name
}

output "worker_name" {
  value = cloudflare_workers_script.test.script_name
}
