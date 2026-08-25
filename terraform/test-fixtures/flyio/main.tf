# Fly.io connector test fixtures
#
# Provisions a Fly app with one Machine. Free allowance covers up to 3 shared
# VMs, so this costs nothing if you have no other Fly apps running.
#
# Required env vars:
#   FLY_API_TOKEN (from `fly tokens create`)
#
# Cost: $0 (free allowance: 3 shared-cpu-1x VMs)

terraform {
  required_version = ">= 1.5"
  required_providers {
    fly = {
      source  = "fly-apps/fly"
      version = "~> 0.0.23"
    }
  }
}

provider "fly" {}

variable "region" {
  default = "iad"
}

variable "org" {
  description = "Fly.io organization slug (usually 'personal')"
  default     = "personal"
}

# Fly app
resource "fly_app" "test" {
  name = "infralift-test"
  org  = var.org
}

# Machine (shared-cpu-1x, smallest config)
resource "fly_machine" "test" {
  app    = fly_app.test.name
  name   = "infralift-test-machine"
  region = var.region
  image  = "nginx:alpine"

  cpus     = 1
  cputype  = "shared"
  memorymb = 256

  services = [
    {
      internal_port = 80
      protocol      = "tcp"
      ports = [
        {
          port     = 443
          handlers = ["tls", "http"]
        },
        {
          port     = 80
          handlers = ["http"]
        }
      ]
    }
  ]
}

# Volume (1GB, ~$0.15/mo)
resource "fly_volume" "test" {
  app    = fly_app.test.name
  name   = "infralift_test_data"
  region = var.region
  size   = 1
}

output "app_name" {
  value = fly_app.test.name
}

output "app_url" {
  value = "https://${fly_app.test.name}.fly.dev"
}
