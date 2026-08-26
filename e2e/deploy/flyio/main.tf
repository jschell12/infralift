# Fly.io E2E deployment for infralift-demo
#
# Provisions a Fly app, a Machine (shared-cpu-1x, 256MB), and a 1GB volume.
# Fly Postgres is user-managed (not a managed service), so Postgres is handled
# externally via Neon. Pass the Neon connection string as neon_database_url.
#
# Prerequisites:
#   - Fly.io account with a valid API token
#   - Docker image pushed to a public registry
#   - Neon database provisioned separately (https://neon.tech)
#
# Required env vars:
#   FLY_API_TOKEN (from `fly tokens create`)
#   TF_VAR_neon_database_url
#
# Cost estimate:
#   Shared-cpu-1x, 256MB: $0 (free allowance covers 3 shared VMs)
#   1GB volume: ~$0.15/mo
#   Neon free tier: $0
#   Total: ~$0.15/mo

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

# ---------- Fly app ----------

resource "fly_app" "app" {
  name = var.app_name
  org  = var.org
}

# ---------- Volume ----------

resource "fly_volume" "data" {
  app    = fly_app.app.name
  name   = "infralift_e2e_data"
  region = var.region
  size   = 1
}

# ---------- Machine ----------

resource "fly_machine" "web" {
  app    = fly_app.app.name
  name   = "${var.app_name}-web"
  region = var.region
  image  = var.docker_image

  cpus     = 1
  cputype  = "shared"
  memorymb = 256

  env = {
    DATABASE_URL  = var.neon_database_url
    PROVIDER_NAME = "flyio"
    PORT          = "3000"
  }

  services = [
    {
      internal_port = 3000
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

  mounts = [
    {
      volume = fly_volume.data.id
      path   = "/data"
    }
  ]
}
