#!/usr/bin/env bash
set -euo pipefail

echo "=== Tearing down infralift-demo on Render ==="

: "${RENDER_API_KEY:?Set RENDER_API_KEY}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENDER_API="https://api.render.com/v1"

# Read saved IDs, or accept them from env
SVC_ID="${RENDER_SERVICE_ID:-$(cat "$SCRIPT_DIR/.service_id" 2>/dev/null || true)}"
DB_ID="${RENDER_DATABASE_ID:-$(cat "$SCRIPT_DIR/.database_id" 2>/dev/null || true)}"

# Delete the web service
if [ -n "$SVC_ID" ]; then
  echo "Deleting web service: $SVC_ID"
  curl -s -X DELETE "$RENDER_API/services/$SVC_ID" \
    -H "Authorization: Bearer $RENDER_API_KEY"
  echo " done"
else
  echo "No service ID found. Set RENDER_SERVICE_ID or ensure .service_id exists."
fi

# Delete the database
if [ -n "$DB_ID" ]; then
  echo "Deleting database: $DB_ID"
  curl -s -X DELETE "$RENDER_API/postgres/$DB_ID" \
    -H "Authorization: Bearer $RENDER_API_KEY"
  echo " done"
else
  echo "No database ID found. Set RENDER_DATABASE_ID or ensure .database_id exists."
fi

# Clean up saved ID files
rm -f "$SCRIPT_DIR/.service_id" "$SCRIPT_DIR/.database_id"

echo "=== Teardown complete ==="
