#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required env vars
: "${NETLIFY_API_TOKEN:?Set NETLIFY_API_TOKEN (personal access token from app.netlify.com)}"
: "${TF_VAR_team_slug:?Set TF_VAR_team_slug to your Netlify team slug}"
: "${TF_VAR_neon_database_url:?Set TF_VAR_neon_database_url to your Neon Postgres connection string}"

echo "==> Initializing Terraform..."
terraform init

echo "==> Applying infrastructure (DNS zone + env vars on existing site)..."
terraform apply -auto-approve

echo "==> Seeding database (via Neon)..."
cd ../../reference-app
DATABASE_URL="$TF_VAR_neon_database_url" node seed.js

SITE_URL=$(cd "$SCRIPT_DIR" && terraform output -raw site_url)

echo ""
echo "Terraform config applied (DNS zone + env vars)."
echo "  Site URL: $SITE_URL"
echo ""
echo "NOTE: The Netlify provider cannot create or deploy sites."
echo "To deploy the app, run from the reference-app directory:"
echo "  netlify deploy --prod --dir=public --functions=functions"
