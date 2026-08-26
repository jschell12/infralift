#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/../../reference-app"
FUNCTIONS_DIR="$SCRIPT_DIR/functions"

echo "=== Deploying infralift-demo to Firebase ==="

# Check required env vars
: "${FIREBASE_TOKEN:?Set FIREBASE_TOKEN (run: firebase login:ci)}"
: "${FIREBASE_PROJECT:?Set FIREBASE_PROJECT to your Firebase project ID}"
: "${DATABASE_URL:?Set DATABASE_URL (Neon or other external Postgres)}"

# Update .firebaserc with the actual project ID
sed "s/YOUR_FIREBASE_PROJECT_ID/$FIREBASE_PROJECT/" \
  "$SCRIPT_DIR/.firebaserc" > "$SCRIPT_DIR/.firebaserc.tmp"
mv "$SCRIPT_DIR/.firebaserc.tmp" "$SCRIPT_DIR/.firebaserc"

# --- Prepare the functions directory ---
# Copy reference app files into the functions directory so the Cloud Function
# can access them.
echo "Copying reference app into functions directory..."
cp "$APP_DIR/server.js" "$FUNCTIONS_DIR/server.js"
cp "$APP_DIR/seed.js" "$FUNCTIONS_DIR/seed.js"
cp -r "$APP_DIR/views" "$FUNCTIONS_DIR/views"
cp -r "$APP_DIR/public" "$FUNCTIONS_DIR/public"

# Create a package.json for the functions directory
cat > "$FUNCTIONS_DIR/package.json" <<'PKGJSON'
{
  "name": "infralift-demo-firebase",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "engines": {
    "node": "22"
  },
  "dependencies": {
    "express": "^4.21.0",
    "multer": "^1.4.5-lts.1",
    "pg": "^8.13.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^6.0.0"
  }
}
PKGJSON

# Install function dependencies
echo "Installing function dependencies..."
cd "$FUNCTIONS_DIR"
npm ci --production

# --- Set environment config ---
# Firebase v2 functions use environment variables set via Google Cloud Secret
# Manager or --set-env-vars at deploy time.
echo "Setting function environment variables..."
cd "$SCRIPT_DIR"

DEPLOY_ENV="DATABASE_URL=$DATABASE_URL,PROVIDER_NAME=firebase"
[ -n "${STORAGE_ENDPOINT:-}" ] && DEPLOY_ENV="$DEPLOY_ENV,STORAGE_ENDPOINT=$STORAGE_ENDPOINT"
[ -n "${STORAGE_BUCKET:-}" ] && DEPLOY_ENV="$DEPLOY_ENV,STORAGE_BUCKET=$STORAGE_BUCKET"
[ -n "${STORAGE_ACCESS_KEY:-}" ] && DEPLOY_ENV="$DEPLOY_ENV,STORAGE_ACCESS_KEY=$STORAGE_ACCESS_KEY"
[ -n "${STORAGE_SECRET_KEY:-}" ] && DEPLOY_ENV="$DEPLOY_ENV,STORAGE_SECRET_KEY=$STORAGE_SECRET_KEY"

# Deploy hosting + functions
echo "Deploying to Firebase..."
firebase deploy \
  --project "$FIREBASE_PROJECT" \
  --token "$FIREBASE_TOKEN" \
  --only hosting,functions \
  --set-env-vars "$DEPLOY_ENV"

# Seed the external database
echo "Seeding database..."
cd "$FUNCTIONS_DIR"
DATABASE_URL="$DATABASE_URL" node seed.js

echo "=== Deployment complete ==="
echo "App URL: https://${FIREBASE_PROJECT}.web.app"
echo ""
echo "Note: Firebase does not provide managed Postgres. This deploy uses an"
echo "external Postgres database (Neon recommended). Firestore could replace"
echo "Postgres for a fully Firebase-native stack, but that would require app"
echo "changes outside the scope of this E2E demo."
