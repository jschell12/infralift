#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/../../reference-app"

echo "=== Deploying infralift-demo to Render ==="

# Check required env vars
: "${RENDER_API_KEY:?Set RENDER_API_KEY}"

RENDER_API="https://api.render.com/v1"
OWNER_ID="${RENDER_OWNER_ID:-}"

# If owner ID is not set, fetch it from the API
if [ -z "$OWNER_ID" ]; then
  echo "Fetching Render owner ID..."
  OWNER_ID=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
    "$RENDER_API/owners" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['owner']['id'])")
  echo "Using owner: $OWNER_ID"
fi

# --- Create the PostgreSQL database ---
echo "Creating PostgreSQL database..."
DB_RESPONSE=$(curl -s -X POST "$RENDER_API/postgres" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"infralift-demo-db\",
    \"ownerId\": \"$OWNER_ID\",
    \"plan\": \"free\",
    \"region\": \"oregon\",
    \"version\": \"16\",
    \"databaseName\": \"infralift_demo\"
  }")

DB_ID=$(echo "$DB_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Database created: $DB_ID"

# Wait for the database to be available and get internal connection string
echo "Waiting for database to provision (this may take a few minutes)..."
for i in $(seq 1 30); do
  DB_STATUS=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
    "$RENDER_API/postgres/$DB_ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))")
  if [ "$DB_STATUS" = "available" ]; then
    break
  fi
  echo "  Status: $DB_STATUS (attempt $i/30)"
  sleep 10
done

# Get the internal database URL
DB_INFO=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/postgres/$DB_ID")
DATABASE_URL=$(echo "$DB_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)['internalConnectionString'])")
EXTERNAL_DB_URL=$(echo "$DB_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)['connectionString'])")

# --- Create the web service ---
echo "Creating web service..."
SVC_RESPONSE=$(curl -s -X POST "$RENDER_API/services" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"infralift-demo\",
    \"ownerId\": \"$OWNER_ID\",
    \"type\": \"web_service\",
    \"runtime\": \"docker\",
    \"region\": \"oregon\",
    \"plan\": \"free\",
    \"dockerfilePath\": \"./Dockerfile\",
    \"envVars\": [
      {\"key\": \"DATABASE_URL\", \"value\": \"$DATABASE_URL\"},
      {\"key\": \"PROVIDER_NAME\", \"value\": \"render\"},
      {\"key\": \"PORT\", \"value\": \"3000\"}
    ]
  }")

SVC_ID=$(echo "$SVC_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['service']['id'])")
echo "Service created: $SVC_ID"

# Seed the database using the external connection string
echo "Seeding database..."
cd "$APP_DIR"
DATABASE_URL="$EXTERNAL_DB_URL" node seed.js

# Save IDs for teardown
echo "$SVC_ID" > "$SCRIPT_DIR/.service_id"
echo "$DB_ID" > "$SCRIPT_DIR/.database_id"

echo "=== Deployment complete ==="
echo "Service ID: $SVC_ID"
echo "Database ID: $DB_ID"
echo "App URL: https://infralift-demo.onrender.com"
echo ""
echo "Note: Render deploys from a connected Git repo or via the API."
echo "For repo-based deploys, push the reference-app with render.yaml to a"
echo "GitHub repo and connect it in the Render dashboard."
echo ""
echo "IDs saved to $SCRIPT_DIR/.service_id and $SCRIPT_DIR/.database_id for teardown."
