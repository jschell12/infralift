#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Tearing down infralift-demo on Firebase ==="

: "${FIREBASE_TOKEN:?Set FIREBASE_TOKEN}"
: "${FIREBASE_PROJECT:?Set FIREBASE_PROJECT}"

# Disable hosting (takes the site offline)
echo "Disabling Firebase Hosting..."
firebase hosting:disable \
  --project "$FIREBASE_PROJECT" \
  --token "$FIREBASE_TOKEN" \
  --force

# Delete the Cloud Function
echo "Deleting Cloud Function..."
firebase functions:delete app \
  --project "$FIREBASE_PROJECT" \
  --token "$FIREBASE_TOKEN" \
  --force

# Clean up copied files from the functions directory
echo "Cleaning up local function artifacts..."
rm -f "$SCRIPT_DIR/functions/server.js"
rm -f "$SCRIPT_DIR/functions/seed.js"
rm -rf "$SCRIPT_DIR/functions/views"
rm -rf "$SCRIPT_DIR/functions/public"
rm -rf "$SCRIPT_DIR/functions/node_modules"
rm -f "$SCRIPT_DIR/functions/package.json"
rm -f "$SCRIPT_DIR/functions/package-lock.json"

echo "=== Teardown complete ==="
echo "Note: The Firebase project itself is not deleted. Delete it manually"
echo "in the Firebase console if no longer needed."
echo "External Postgres (Neon) database is also not deleted by this script."
