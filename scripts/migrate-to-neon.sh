#!/usr/bin/env bash
# migrate-to-neon.sh — Migrate infralift database from homelab Postgres to Neon
#
# Prerequisites:
#   - pg_dump and pg_restore available locally
#   - HOMELAB_DATABASE_URL set (homelab Postgres connection string)
#   - NEON_DATABASE_URL set (Neon connection string from dashboard)
#
# Usage:
#   export HOMELAB_DATABASE_URL="postgresql://infralift:pass@10.0.0.2:5432/infralift"
#   export NEON_DATABASE_URL="postgresql://user:pass@ep-xxx.us-east-1.aws.neon.tech/infralift?sslmode=require"
#   bash scripts/migrate-to-neon.sh

set -euo pipefail

HOMELAB_URL="${HOMELAB_DATABASE_URL:?Set HOMELAB_DATABASE_URL}"
NEON_URL="${NEON_DATABASE_URL:?Set NEON_DATABASE_URL}"
DUMP_FILE="/tmp/infralift-$(date +%Y%m%d-%H%M%S).dump"

echo "=== Step 1: Dump from homelab ==="
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$HOMELAB_URL" > "$DUMP_FILE"
echo "Dump written to $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

echo ""
echo "=== Step 2: Restore to Neon ==="
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$NEON_URL" "$DUMP_FILE"

echo ""
echo "=== Step 3: Validate schema with Prisma ==="
cd "$(dirname "$0")/../apps/api"
DATABASE_URL="$NEON_URL" npx prisma migrate deploy
cd - > /dev/null

echo ""
echo "=== Step 4: Verify row counts ==="
TABLES=(
  "Org" "User" "ProviderConnection" "Assessment" "InventoryItem" "Finding"
  "Migration" "MigrationPhase" "Workspace"
  "HostingProvider" "ProviderCapability" "ProviderPlan" "DiscountProgram" "DiscountTier"
  "TfTemplate" "TfTemplateVersion" "TfProject" "TfRendering" "TfJob"
  "AppProfile"
)

all_ok=true
for table in "${TABLES[@]}"; do
  homelab=$(psql "$HOMELAB_URL" -t -c "SELECT count(*) FROM \"$table\"" 2>/dev/null | tr -d ' ' || echo "ERR")
  neon=$(psql "$NEON_URL" -t -c "SELECT count(*) FROM \"$table\"" 2>/dev/null | tr -d ' ' || echo "ERR")
  if [[ "$homelab" == "$neon" ]]; then
    status="OK"
  else
    status="MISMATCH"
    all_ok=false
  fi
  printf "  %-25s homelab=%-6s neon=%-6s %s\n" "$table" "$homelab" "$neon" "$status"
done

echo ""
if $all_ok; then
  echo "=== All row counts match ==="
else
  echo "=== WARNING: Some row counts differ — investigate before switching ==="
fi

echo ""
echo "=== Done ==="
echo "New DATABASE_URL for Vault:"
echo "  vault kv put secret/infralift DATABASE_URL=\"$NEON_URL\" TOKEN_ENCRYPTION_KEY=\$(vault kv get -field=TOKEN_ENCRYPTION_KEY secret/infralift)"
echo ""
echo "Then restart the infralift Nomad job:"
echo "  nomad job restart infralift"
