# DigitalOcean E2E deployment for infralift-demo
#
# Provisions an App Platform app (Docker service), Managed Database cluster
# (Postgres, db-s-1vcpu-1gb), and a Spaces bucket for object storage.
#
# Prerequisites:
#   - DigitalOcean personal access token with read+write
#   - Docker image pushed to a public registry (Docker Hub or DOCR)
#
# Required env vars:
#   DIGITALOCEAN_TOKEN (or TF_VAR_do_token)
#
# Cost estimate:
#   App Platform (Basic): ~$5/mo
#   Managed Postgres (db-s-1vcpu-1gb): ~$15/mo
#   Spaces (250GB included): ~$5/mo
#   Total: ~$25/mo (new accounts get $200/60-day credit)

terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.100"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name = "infralift-e2e-${random_id.suffix.hex}"
}

# ---------- Managed Postgres ----------

resource "digitalocean_database_cluster" "postgres" {
  name       = "${local.name}-pg"
  engine     = "pg"
  version    = "16"
  size       = "db-s-1vcpu-1gb"
  region     = var.region
  node_count = 1

  tags = ["infralift-e2e", "terraform"]
}

resource "digitalocean_database_db" "infralift" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "infralift"
}

# Allow all inbound connections for demo (restrict in production)
resource "digitalocean_database_firewall" "allow_all" {
  cluster_id = digitalocean_database_cluster.postgres.id

  rule {
    type  = "ip_addr"
    value = "0.0.0.0/0"
  }
}

# ---------- Spaces bucket ----------

resource "digitalocean_spaces_bucket" "storage" {
  name          = local.name
  region        = var.region
  acl           = "private"
  force_destroy = true
}

# ---------- App Platform ----------

resource "digitalocean_app" "app" {
  spec {
    name   = local.name
    region = var.region

    service {
      name               = "web"
      instance_size_slug = "apps-s-1vcpu-0.5gb"
      instance_count     = 1
      http_port          = 3000

      image {
        registry_type = "DOCKER_HUB"
        registry      = "library"
        repository    = "node"
        tag           = "22-slim"
      }

      env {
        key   = "DATABASE_URL"
        value = digitalocean_database_cluster.postgres.uri
        type  = "SECRET"
      }

      env {
        key   = "PROVIDER_NAME"
        value = "digitalocean"
      }

      env {
        key   = "STORAGE_ENDPOINT"
        value = "https://${var.region}.digitaloceanspaces.com"
      }

      env {
        key   = "STORAGE_BUCKET"
        value = digitalocean_spaces_bucket.storage.name
      }
    }
  }
}
