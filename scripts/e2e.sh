#!/usr/bin/env bash
# The zero-cost end-to-end suite: brings up docker-compose.e2e.yml, runs
# apps/api/e2e against it, and tears it down. No cloud account, no git host,
# no spend. See README, "Testing without cloud accounts".
#
#   scripts/e2e.sh                          the whole suite
#   scripts/e2e.sh e2e/adopt-aws.e2e.test.ts   one file (vitest arguments)
#   E2E_KEEP=1 scripts/e2e.sh               leave the stack running afterwards
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f docker-compose.e2e.yml --profile tools)

stop() {
  if [ "${E2E_KEEP:-}" = "1" ]; then
    echo "E2E_KEEP=1: stack left running; stop it with: ${compose[*]} down"
    return
  fi
  # Postgres is on tmpfs and moto keeps state in memory, so removing the
  # containers resets both. The provider cache volume is kept, which saves
  # downloading the providers on every run.
  "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap stop EXIT

# A fresh stack every run: leftovers from an aborted run would collide.
"${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" build tofu
docker compose -f docker-compose.e2e.yml up -d --wait

pnpm --filter @infralift/api exec vitest run --config vitest.e2e.config.ts "$@"
