#!/usr/bin/env bash
# restore.sh <env> < dump: replaces <env>'s database with the archive on stdin.
# Destructive. The nightly workflow never calls this; it restores into a
# throwaway Postgres on the runner to prove the dump is good.
set -euo pipefail
ENV="$1"
ROOT="${AF_ROOT:-/srv/app-foundry}"
CODE="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$ENV" =~ ^(prod|pr-[0-9]+)$ ]] || { echo "bad env: $ENV" >&2; exit 2; }

# compose.yml needs these to parse; exec and down never recreate containers.
export ENV ENV_DIR="$ROOT/envs/$ENV" PG_DATA=pgdata TAG=none REGISTRY=none
docker compose -p "af-$ENV" -f "$CODE/compose.yml" exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner'
