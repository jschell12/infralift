# Netlify E2E deployment for infralift-demo
#
# The Netlify Terraform provider (v0.4) cannot create sites. Sites must be
# created manually through the Netlify dashboard or CLI first. This config
# manages a DNS zone and environment variables on an existing site.
#
# The Express app runs via Netlify Functions using the serverless-http adapter.
# Deploy the app using `netlify deploy` CLI, not Terraform.
#
# Prerequisites:
#   1. Create a free site at app.netlify.com ("Add new site" > "Deploy manually")
#   2. Note the site name (e.g. "infralift-e2e")
#   3. Provision a Neon database at neon.tech (Postgres)
#
# Required env vars:
#   NETLIFY_API_TOKEN (personal access token from app.netlify.com)
#   TF_VAR_team_slug, TF_VAR_neon_database_url
#
# Cost estimate:
#   Netlify free tier: 100GB bandwidth, 300 build min/mo
#   Neon free tier: 0.5GB, 190 compute hours/mo
#   Total: $0

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

# ---------- Existing site (data source, not resource) ----------
#
# The Netlify provider cannot create sites. Reference an existing one.

data "netlify_site" "app" {
  name = var.site_name
}

# ---------- DNS zone ----------

resource "netlify_dns_zone" "zone" {
  name      = "${var.site_name}.example"
  team_slug = var.team_slug
}

# ---------- Environment variables ----------

resource "netlify_environment_variable" "database_url" {
  site_id = data.netlify_site.app.id
  key     = "DATABASE_URL"
  values = [
    {
      value   = var.neon_database_url
      context = "all"
    }
  ]
}

resource "netlify_environment_variable" "provider_name" {
  site_id = data.netlify_site.app.id
  key     = "PROVIDER_NAME"
  values = [
    {
      value   = "netlify"
      context = "all"
    }
  ]
}

resource "netlify_environment_variable" "node_version" {
  site_id = data.netlify_site.app.id
  key     = "NODE_VERSION"
  values = [
    {
      value   = "22"
      context = "all"
    }
  ]
}
