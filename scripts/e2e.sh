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

# This checkout's compose project and ports (apps/api/e2e/harness/ports.ts),
# so a run in another worktree does not share or tear down this one's stack.
# Captured first, not eval'd inline: `eval "$(cmd)"` succeeds when cmd fails
# (it evals nothing), and the run would go on with compose's default project
# and ports. ports.ts also refuses a preset COMPOSE_PROJECT_NAME or E2E_PORT_*
# that disagrees with the layout.
if ! layout="$(pnpm --silent --filter @infralift/api exec tsx e2e/harness/ports.ts)"; then
  echo "e2e: could not work out this checkout's compose project and ports (apps/api/e2e/harness/ports.ts failed; its message is above)" >&2
  exit 1
fi
if ! grep -q '^export COMPOSE_PROJECT_NAME=' <<<"$layout" || ! grep -q '^export E2E_PORT_BASE=' <<<"$layout"; then
  echo "e2e: apps/api/e2e/harness/ports.ts printed no COMPOSE_PROJECT_NAME or E2E_PORT_BASE; refusing to start a stack with compose's defaults" >&2
  exit 1
fi
eval "$layout"
echo "e2e stack: project ${COMPOSE_PROJECT_NAME}, ports ${E2E_PORT_BASE}-$((E2E_PORT_BASE + 99))"

compose=(docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml --profile tools --profile mocks)

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
# Render's description has no licence, so its subset is not committed: write
# it from the pin (verified by sha256) before Prism mounts the specs.
pnpm --filter @infralift/api e2e:specs render
docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.e2e.yml --profile mocks up -d --wait

pnpm --filter @infralift/api exec vitest run --config vitest.e2e.config.ts "$@"
