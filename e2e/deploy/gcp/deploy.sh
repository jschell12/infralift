#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required env vars
: "${TF_VAR_project_id:?Set TF_VAR_project_id to your GCP project ID}"
: "${TF_VAR_db_password:?Set TF_VAR_db_password to a strong Postgres password}"

# Verify GCP credentials
if ! gcloud auth application-default print-access-token &>/dev/null 2>&1; then
  echo "WARNING: gcloud application-default credentials not found."
  echo "Run 'gcloud auth application-default login' or set GOOGLE_CREDENTIALS."
fi

echo "==> Initializing Terraform..."
terraform init

echo "==> Applying infrastructure..."
terraform apply -auto-approve

echo "==> Extracting DATABASE_URL..."
DATABASE_URL=$(terraform output -raw database_url)
CLOUD_RUN_URL=$(terraform output -raw cloud_run_url)

echo "==> Seeding database..."
cd ../../reference-app
DATABASE_URL="$DATABASE_URL" node seed.js

echo ""
echo "Deployment complete."
echo "  Cloud Run URL: $CLOUD_RUN_URL"
echo "  Bucket:        $(cd "$SCRIPT_DIR" && terraform output -raw bucket_name)"
