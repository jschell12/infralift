# Cloudflare Workers + R2 + Neon migration target
#
# Provisions a Cloudflare Workers script (the reference app), an R2 bucket for
# object storage, a Neon Postgres database, and a DNS CNAME record.
#
# Prerequisites:
#   - Cloudflare API token with Workers, R2, and DNS permissions
#   - Neon API key (https://console.neon.tech/app/settings/api-keys)
#
# Cost estimate:
#   Workers Paid: $5/mo (10M req included)
#   R2: 10GB free, $0.015/GB after
#   Neon Free: 0.5 GiB storage, 190 compute hours
#   Total: ~$5-25/mo depending on usage

terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.6"
    }
  }
}

provider "cloudflare" {
  # Uses CLOUDFLARE_API_TOKEN env var
}

provider "neon" {
  api_key = var.neon_api_key
}

# ---------- Neon Postgres ----------

resource "neon_project" "app" {
  name      = var.app_name
  region_id = "aws-us-east-1"
}

resource "neon_database" "app" {
  project_id = neon_project.app.id
  branch_id  = neon_project.app.default_branch_id
  name       = var.app_name
  owner_name = neon_project.app.database_user
}

# ---------- R2 bucket ----------

resource "cloudflare_r2_bucket" "storage" {
  account_id = var.cloudflare_account_id
  name       = "${var.app_name}-storage"
  location   = "ENAM"
}

# ---------- Workers script ----------
#
# Minimal worker stub. In a real migration, replace the content with the
# bundled Express app adapted for Workers (e.g. via wrangler build or esbuild).

resource "cloudflare_workers_script" "app" {
  account_id  = var.cloudflare_account_id
  script_name = var.app_name

  main_module        = "worker.js"
  compatibility_date = "2024-01-01"

  content = <<-JS
    export default {
      async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === "/health") return Response.json({ healthy: true });
        if (url.pathname === "/api/status") {
          return Response.json({
            status: "ok",
            provider: "cloudflare",
            timestamp: new Date().toISOString(),
          });
        }
        return Response.json({
          provider: "cloudflare",
          message: "infralift-demo migrated to Cloudflare Workers",
        });
      }
    };
  JS

  bindings = [
    {
      name        = "STORAGE"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.storage.name
    },
    {
      name = "DATABASE_URL"
      type = "secret_text"
      text = "postgresql://${neon_project.app.database_user}:${neon_project.app.database_password}@${neon_project.app.database_host}/${neon_database.app.name}?sslmode=require"
    },
    {
      name = "PROVIDER_NAME"
      type = "plain_text"
      text = "cloudflare"
    },
  ]
}

# ---------- DNS ----------

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = var.app_name
  type    = "CNAME"
  content = "${var.app_name}.${var.domain}.workers.dev"
  proxied = true
  ttl     = 1
}
