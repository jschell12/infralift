#!/usr/bin/env bash
# teardown.sh <env>: removes a preview and its data. Never production.
set -euo pipefail
ENV="$1"
ROOT="${AF_ROOT:-/srv/app-foundry}"
CODE="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$ENV" =~ ^pr-[0-9]+$ ]] || { echo "teardown only removes previews, not $ENV" >&2; exit 2; }

rm -f "$ROOT/sites/$ENV.caddy"
docker exec caddy caddy reload --config /etc/caddy/conf/Caddyfile --adapter caddyfile 2>/dev/null || true

if [[ -d "$ROOT/envs/$ENV" ]]; then
  # compose.yml needs these to parse; exec and down never recreate containers.
  export ENV ENV_DIR="$ROOT/envs/$ENV" PG_DATA=pgdata TAG=none REGISTRY=none
  docker compose -p "af-$ENV" -f "$CODE/compose.yml" down -v --remove-orphans
  rm -rf "$ROOT/envs/$ENV"
fi
# Run from production's copy (the workflow does), so this is never the code being removed.
[[ "$CODE" == "$ROOT/code/$ENV" ]] || rm -rf "$ROOT/code/$ENV"
echo "removed $ENV"
