#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required env vars
: "${TF_VAR_db_password:?Set TF_VAR_db_password to a strong Postgres password}"

# Verify AWS credentials are available
if ! aws sts get-caller-identity &>/dev/null; then
  echo "ERROR: AWS credentials not configured. Run 'aws configure' or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY."
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
echo "  Bucket:   $(cd "$SCRIPT_DIR" && terraform output -raw bucket_name)"
