#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/../../reference-app"

echo "=== Deploying infralift-demo to Heroku ==="

# Check required tools and env
: "${HEROKU_API_KEY:?Set HEROKU_API_KEY (or log in with heroku auth:login)}"

APP_NAME="infralift-demo-$(date +%s | tail -c 7)"

# Create the app
echo "Creating Heroku app: $APP_NAME"
heroku create "$APP_NAME" --stack heroku-24

# Add Postgres addon (provides DATABASE_URL automatically)
echo "Adding heroku-postgresql:essential-0 addon..."
heroku addons:create heroku-postgresql:essential-0 --app "$APP_NAME" --wait

# Set config vars
heroku config:set \
  PROVIDER_NAME=heroku \
  ${STORAGE_ENDPOINT:+STORAGE_ENDPOINT="$STORAGE_ENDPOINT"} \
  ${STORAGE_BUCKET:+STORAGE_BUCKET="$STORAGE_BUCKET"} \
  ${STORAGE_ACCESS_KEY:+STORAGE_ACCESS_KEY="$STORAGE_ACCESS_KEY"} \
  ${STORAGE_SECRET_KEY:+STORAGE_SECRET_KEY="$STORAGE_SECRET_KEY"} \
  --app "$APP_NAME"

# Copy platform files into app directory for deploy
cp "$SCRIPT_DIR/Procfile" "$APP_DIR/Procfile"
cp "$SCRIPT_DIR/app.json" "$APP_DIR/app.json"

# Deploy via container registry (avoids needing a git remote)
cd "$APP_DIR"
heroku container:login
heroku container:push web --app "$APP_NAME"
heroku container:release web --app "$APP_NAME"

# Wait for the app to start
echo "Waiting for app to become available..."
sleep 10

# Run the seed script
echo "Seeding database..."
heroku run "node seed.js" --app "$APP_NAME"

# Clean up copied files
rm -f "$APP_DIR/Procfile" "$APP_DIR/app.json"

APP_URL="https://${APP_NAME}.herokuapp.com"

echo "=== Deployment complete ==="
echo "App URL: $APP_URL"
echo "App name: $APP_NAME"
echo ""
echo "Save the app name for teardown: HEROKU_APP=$APP_NAME"
