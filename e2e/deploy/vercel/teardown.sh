#!/usr/bin/env bash
set -euo pipefail

echo "=== Tearing down infralift-demo on Vercel ==="

: "${VERCEL_TOKEN:?Set VERCEL_TOKEN}"

PROJECT_NAME="infralift-demo"

npx vercel rm "$PROJECT_NAME" --yes --token "$VERCEL_TOKEN"

echo "=== Teardown complete ==="
echo "Note: External Postgres (Neon) database is not deleted by this script."
echo "Delete the Neon project manually if no longer needed."
