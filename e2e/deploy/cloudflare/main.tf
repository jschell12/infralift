# Cloudflare E2E deployment for infralift-demo
#
# Provisions a Workers script and R2 bucket. Postgres is handled externally
# via Neon (or any Postgres provider) since Cloudflare does not offer managed
# Postgres. Pass the Neon connection string as neon_database_url.
#
# The Worker script is a minimal adapter that proxies requests. For a full
# deployment, replace the content attribute with the actual app code adapted
# for the Workers runtime (using serverless-http or similar).
#
# Prerequisites:
#   - Cloudflare API token with Workers Scripts:Edit, R2:Edit permissions
#   - A Neon database provisioned separately (https://neon.tech)
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN
#   TF_VAR_account_id, TF_VAR_neon_database_url
#
# Cost estimate:
#   Workers free: 100k req/day, 10ms CPU/req
#   R2 free: 10GB storage, 1M Class A ops/mo, 10M Class B ops/mo
#   Neon free: 0.5GB storage, 190 compute hours/mo
#   Total: $0 (within free tiers)

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

# ---------- R2 bucket ----------

resource "cloudflare_r2_bucket" "storage" {
  account_id = var.account_id
  name       = "infralift-e2e"
}

# ---------- Workers script ----------
#
# This is a minimal worker that returns JSON status. In a real deployment,
# you would bundle the Express app with a Workers adapter (e.g. using
# wrangler or esbuild) and set the content to the bundled output.

resource "cloudflare_workers_script" "app" {
  account_id = var.account_id
  script_name = "infralift-e2e"

  main_module        = "index.js"
  compatibility_date = "2024-12-01"

  content = <<-JS
    export default {
      async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
          return Response.json({ healthy: true });
        }

        if (url.pathname === "/api/status") {
          return Response.json({
            status: "ok",
            provider: "cloudflare",
            timestamp: new Date().toISOString(),
            note: "Full app requires Workers adapter build"
          });
        }

        return Response.json({
          provider: "cloudflare",
          message: "infralift-demo running on Cloudflare Workers",
          endpoints: ["/health", "/api/status"]
        });
      }
    };
  JS

  # Bindings: R2 bucket + secrets (v5 provider uses `bindings` attribute list)
  bindings = [
    {
      name        = "STORAGE"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.storage.name
    },
    {
      name = "DATABASE_URL"
      type = "secret_text"
      text = var.neon_database_url
    },
  ]
}
