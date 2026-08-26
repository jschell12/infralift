#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/../../reference-app"

echo "=== Deploying infralift-demo to Railway ==="

# Check required env vars
: "${RAILWAY_TOKEN:?Set RAILWAY_TOKEN}"

export RAILWAY_TOKEN

# Copy platform config into the app directory
cp "$SCRIPT_DIR/railway.toml" "$APP_DIR/railway.toml"

cd "$APP_DIR"

# Create a new project
echo "Creating Railway project..."
railway init --name infralift-demo

# Add Postgres plugin
echo "Adding Postgres plugin..."
railway add --plugin postgresql

# Set environment variables
echo "Setting environment variables..."
railway variables set \
  PROVIDER_NAME=railway \
  PORT=3000 \
  ${STORAGE_ENDPOINT:+STORAGE_ENDPOINT="$STORAGE_ENDPOINT"} \
  ${STORAGE_BUCKET:+STORAGE_BUCKET="$STORAGE_BUCKET"} \
  ${STORAGE_ACCESS_KEY:+STORAGE_ACCESS_KEY="$STORAGE_ACCESS_KEY"} \
  ${STORAGE_SECRET_KEY:+STORAGE_SECRET_KEY="$STORAGE_SECRET_KEY"}

# Railway automatically provides DATABASE_URL when a Postgres plugin is attached

# Deploy the app
echo "Deploying..."
railway up --detach

# Wait for deployment
echo "Waiting for deployment to stabilize..."
sleep 15

# Get the deployment URL
APP_URL=$(railway domain 2>/dev/null || echo "pending")

# Seed the database via railway run
echo "Seeding database..."
railway run node seed.js

# Clean up copied config
rm -f "$APP_DIR/railway.toml"

echo "=== Deployment complete ==="
echo "App URL: https://$APP_URL"
echo ""
echo "Note: DATABASE_URL is provided automatically by the Postgres plugin."
echo "Run 'railway open' to view the project dashboard."
