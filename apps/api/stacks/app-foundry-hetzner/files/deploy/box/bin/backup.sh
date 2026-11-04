#!/usr/bin/env bash
# backup.sh <env>: writes a pg_dump custom-format archive to stdout.
set -euo pipefail
ENV="${1:-prod}"
ROOT="${AF_ROOT:-/srv/app-foundry}"
CODE="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$ENV" =~ ^(prod|pr-[0-9]+)$ ]] || { echo "bad env: $ENV" >&2; exit 2; }

# compose.yml needs these to parse; exec and down never recreate containers.
export ENV ENV_DIR="$ROOT/envs/$ENV" PG_DATA=pgdata TAG=none REGISTRY=none
docker compose -p "af-$ENV" -f "$CODE/compose.yml" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'
