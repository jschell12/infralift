#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/../../reference-app"

echo "=== Deploying infralift-demo to Vercel ==="

# Check required env vars
: "${VERCEL_TOKEN:?Set VERCEL_TOKEN}"
: "${DATABASE_URL:?Set DATABASE_URL (Neon or other external Postgres)}"

# Vercel does not include a managed Postgres addon in the free tier.
# Use Neon (https://neon.tech) or another external Postgres provider and pass
# DATABASE_URL as an environment variable.

PROJECT_NAME="infralift-demo"

# Copy platform config into the app directory
cp "$SCRIPT_DIR/vercel.json" "$APP_DIR/vercel.json"

cd "$APP_DIR"

# Deploy with environment variables
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN" \
  --name "$PROJECT_NAME" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PROVIDER_NAME=vercel \
  -e PORT=3000 \
  ${STORAGE_ENDPOINT:+-e STORAGE_ENDPOINT="$STORAGE_ENDPOINT"} \
  ${STORAGE_BUCKET:+-e STORAGE_BUCKET="$STORAGE_BUCKET"} \
  ${STORAGE_ACCESS_KEY:+-e STORAGE_ACCESS_KEY="$STORAGE_ACCESS_KEY"} \
  ${STORAGE_SECRET_KEY:+-e STORAGE_SECRET_KEY="$STORAGE_SECRET_KEY"}

# Run seed against the external database
echo "Seeding database..."
DATABASE_URL="$DATABASE_URL" node seed.js

# Clean up copied config
rm -f "$APP_DIR/vercel.json"

echo "=== Deployment complete ==="
echo "App URL: https://${PROJECT_NAME}.vercel.app"
echo ""
echo "Note: Postgres is external (Neon recommended). Make sure DATABASE_URL"
echo "points to a provisioned Neon database with network access from Vercel."
