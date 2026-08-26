#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required env vars
: "${FLY_API_TOKEN:?Set FLY_API_TOKEN (from 'fly tokens create')}"
: "${TF_VAR_neon_database_url:?Set TF_VAR_neon_database_url to your Neon Postgres connection string}"

echo "==> Initializing Terraform..."
terraform init

echo "==> Applying infrastructure..."
terraform apply -auto-approve

echo "==> Seeding database (via Neon)..."
cd ../../reference-app
DATABASE_URL="$TF_VAR_neon_database_url" node seed.js

APP_URL=$(cd "$SCRIPT_DIR" && terraform output -raw app_url)

echo ""
echo "Deployment complete."
echo "  App URL: $APP_URL"
