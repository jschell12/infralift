#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required env vars
: "${TF_VAR_subscription_id:?Set TF_VAR_subscription_id to your Azure subscription ID}"
: "${TF_VAR_db_password:?Set TF_VAR_db_password to a strong Postgres password}"

# Verify Azure credentials
if ! az account show &>/dev/null; then
  echo "ERROR: Azure credentials not configured. Run 'az login' or set ARM_* env vars."
  exit 1
fi

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
echo "  Storage:  $(cd "$SCRIPT_DIR" && terraform output -raw storage_account_name)"
