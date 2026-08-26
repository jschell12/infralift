#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required env vars
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${TF_VAR_account_id:?Set TF_VAR_account_id to your Cloudflare account ID}"
: "${TF_VAR_neon_database_url:?Set TF_VAR_neon_database_url to your Neon Postgres connection string}"

echo "==> Initializing Terraform..."
terraform init

echo "==> Applying infrastructure..."
terraform apply -auto-approve

echo "==> Seeding database (via Neon)..."
cd ../../reference-app
DATABASE_URL="$TF_VAR_neon_database_url" node seed.js

echo ""
echo "Deployment complete."
echo "  Worker URL: $(cd "$SCRIPT_DIR" && terraform output -raw worker_url)"
echo "  R2 Bucket:  $(cd "$SCRIPT_DIR" && terraform output -raw r2_bucket)"
echo ""
echo "NOTE: Postgres is hosted on Neon (external). The Worker script is a"
echo "minimal stub. For full app functionality, build the Express app with"
echo "a Workers adapter and update the script content."
