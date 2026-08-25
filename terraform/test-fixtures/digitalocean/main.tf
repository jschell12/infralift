# DigitalOcean connector test fixtures
#
# Provisions the smallest Droplet and a domain. New accounts get $200/60-day
# credit, so the $4/mo Droplet is free during that window.
#
# Required env vars:
#   DIGITALOCEAN_TOKEN (personal access token with read+write)
#
# Cost: ~$4/mo (smallest Droplet) — covered by new-account credit

terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.100"
    }
  }
}

provider "digitalocean" {}

variable "region" {
  default = "nyc1"
}

variable "ssh_key_fingerprint" {
  description = "Fingerprint of an SSH key already uploaded to DO (optional, skips SSH key creation)"
  type        = string
  default     = ""
}

# Smallest Droplet ($4/mo — 512MB/1vCPU/10GB)
resource "digitalocean_droplet" "test" {
  name   = "infralift-test"
  region = var.region
  size   = "s-1vcpu-512mb-10gb"
  image  = "ubuntu-24-04-x64"

  ssh_keys = var.ssh_key_fingerprint != "" ? [var.ssh_key_fingerprint] : []

  tags = ["infralift-test"]
}

# Domain (free — just a DNS zone)
resource "digitalocean_domain" "test" {
  name = "infralift-test.example"
}

# App Platform static site (free tier)
resource "digitalocean_app" "test" {
  spec {
    name   = "infralift-test"
    region = var.region

    static_site {
      name          = "placeholder"
      build_command = "echo ok"
      output_dir    = "/"

      git {
        repo_clone_url = "https://github.com/digitalocean/sample-html.git"
        branch         = "main"
      }
    }
  }
}

output "droplet_ip" {
  value = digitalocean_droplet.test.ipv4_address
}

output "app_url" {
  value = digitalocean_app.test.live_url
}

output "domain" {
  value = digitalocean_domain.test.name
}
