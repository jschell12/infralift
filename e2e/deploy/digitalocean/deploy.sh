#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required env vars (provider reads DIGITALOCEAN_TOKEN or TF_VAR_do_token)
if [[ -z "${DIGITALOCEAN_TOKEN:-}" ]] && [[ -z "${TF_VAR_do_token:-}" ]]; then
  echo "ERROR: Set DIGITALOCEAN_TOKEN or TF_VAR_do_token"
  exit 1
fi

# Pass token through if set via DIGITALOCEAN_TOKEN
export TF_VAR_do_token="${TF_VAR_do_token:-$DIGITALOCEAN_TOKEN}"

echo "==> Initializing Terraform..."
terraform init

echo "==> Applying infrastructure..."
terraform apply -auto-approve

echo "==> Extracting DATABASE_URL..."
DATABASE_URL=$(terraform output -raw database_url)
APP_URL=$(terraform output -raw app_url)

echo "==> Seeding database..."
cd ../../reference-app
DATABASE_URL="$DATABASE_URL" node seed.js

echo ""
echo "Deployment complete."
echo "  App URL:  $APP_URL"
echo "  Spaces:   $(cd "$SCRIPT_DIR" && terraform output -raw spaces_endpoint)"
