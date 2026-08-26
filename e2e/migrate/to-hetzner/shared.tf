# Hetzner Cloud VM + Neon Postgres migration target
#
# Provisions a cx22 VM running Docker + Caddy, a Neon Postgres database,
# an SSH key, and a firewall allowing HTTP/HTTPS/SSH.
#
# The VM uses cloud-init to install Docker and Docker Compose, then pulls
# a docker-compose.yml that runs the reference app behind Caddy for
# automatic HTTPS via Let's Encrypt.
#
# Prerequisites:
#   - Hetzner Cloud API token
#   - Neon API key
#   - An SSH public key for VM access
#
# Cost estimate:
#   cx22 (2 vCPU, 4GB): ~EUR 3.99/mo
#   20TB bandwidth included
#   Neon Free: 0.5 GiB storage, 190 compute hours
#   Total: ~$4.50/mo

terraform {
  required_version = ">= 1.5"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.6"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "neon" {
  api_key = var.neon_api_key
}

# ---------- Neon Postgres ----------

resource "neon_project" "app" {
  name      = var.app_name
  region_id = "aws-eu-central-1"
}

resource "neon_database" "app" {
  project_id = neon_project.app.id
  branch_id  = neon_project.app.default_branch_id
  name       = var.app_name
  owner_name = neon_project.app.database_user
}

locals {
  database_url = "postgresql://${neon_project.app.database_user}:${neon_project.app.database_password}@${neon_project.app.database_host}/${neon_database.app.name}?sslmode=require"
}

# ---------- SSH key ----------

resource "hcloud_ssh_key" "deploy" {
  name       = "${var.app_name}-deploy"
  public_key = var.ssh_public_key
}

# ---------- Firewall ----------

resource "hcloud_firewall" "app" {
  name = "${var.app_name}-fw"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# ---------- Server ----------

resource "hcloud_server" "app" {
  name        = var.app_name
  image       = "ubuntu-24.04"
  server_type = "cx22"
  location    = "fsn1"

  ssh_keys     = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.app.id]

  user_data = templatefile("${path.module}/cloud-init.yml", {
    database_url = local.database_url
    domain       = var.domain
    app_name     = var.app_name
  })

  labels = {
    project    = "infralift-e2e"
    managed_by = "terraform"
  }
}
