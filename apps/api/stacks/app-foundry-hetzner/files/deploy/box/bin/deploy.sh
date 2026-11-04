#!/usr/bin/env bash
# deploy.sh <env> <host> <tag> <registry>
#   env       prod | pr-<n>
#   host      public hostname Caddy should answer for. For a preview it is a
#             template containing {slot}, e.g. demo-preview-{slot}.infralift.dev:
#             the box gives the PR the lowest free slot (1..MAX_PREVIEWS) and
#             keeps it until teardown. Those names are declared in tofu, so CI
#             never touches DNS.
#   tag       image tag to run (the commit SHA)
#   registry  e.g. ghcr.io/jschell12
#
# Each environment's copy of deploy/box lives in $ROOT/code/<env>/ and this
# script runs its own compose.yml, so a preview can never change the code
# production runs. Shared state (env credentials, Caddy sites, prod data)
# stays under $ROOT.
#
# AF_ROOT, AF_HTTP_PORT and AF_SKIP_PULL exist for test-local.sh, which runs
# this script against locally built images on a laptop or CI runner.
#
# Idempotent: the first run for an environment creates its credentials, every
# run pulls the images, starts them, waits for health, and routes the host.
# The last line of output is HOST=<the hostname it serves>.
set -euo pipefail

ENV="$1" HOST="$2" TAG="$3" REGISTRY="$4"
ROOT="${AF_ROOT:-/srv/app-foundry}"
CODE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="$ROOT/envs/$ENV"
MAX_PREVIEWS="${MAX_PREVIEWS:-3}"

[[ "$ENV" =~ ^(prod|pr-[0-9]+)$ ]] || { echo "bad env: $ENV" >&2; exit 2; }
if [[ "$ENV" == prod ]]; then
  # Production data must land on the Hetzner volume, never the root disk.
  mountpoint -q "$ROOT/data" || { echo "$ROOT/data is not mounted; refusing to start prod" >&2; exit 1; }
  PG_DATA="$ROOT/data/prod/pg"
  mkdir -p "$PG_DATA"
else
  PG_DATA=pgdata
  mkdir -p "$ROOT/envs"
  # Two PRs deploying at once must not take the same slot.
  exec 9>"$ROOT/envs/.slots.lock"
  if command -v flock >/dev/null; then flock 9; fi
  if [[ -f "$ENV_DIR/slot" ]]; then
    slot=$(cat "$ENV_DIR/slot")
  else
    # No slot files yet is the normal first-preview case, not an error.
    taken=" $(cat "$ROOT"/envs/pr-*/slot 2>/dev/null | tr '\n' ' ' || true) "
    slot=""
    for i in $(seq 1 "$MAX_PREVIEWS"); do
      [[ "$taken" == *" $i "* ]] || { slot=$i; break; }
    done
    [[ -n "$slot" ]] || { echo "all $MAX_PREVIEWS preview slots are in use; close a PR first" >&2; exit 1; }
    mkdir -p "$ENV_DIR"
    echo "$slot" > "$ENV_DIR/slot"
  fi
  exec 9>&-
  HOST=${HOST//\{slot\}/$slot}
fi

[[ "$HOST" =~ ^[a-z0-9.-]+$ ]] || { echo "bad host: $HOST" >&2; exit 2; }

mkdir -p "$ENV_DIR" "$ROOT/sites" "$ROOT/caddy"

# The global Caddyfile belongs to production's code. A preview only seeds it
# on a box production has not deployed to yet.
if [[ "$ENV" == prod || ! -f "$ROOT/caddy/Caddyfile" ]]; then
  cp "$CODE/Caddyfile" "$ROOT/caddy/Caddyfile"
fi
umask 077

if [[ ! -f "$ENV_DIR/db.env" ]]; then
  pw=$(openssl rand -hex 24)
  cat > "$ENV_DIR/db.env" <<ENVEOF
POSTGRES_USER=app
POSTGRES_PASSWORD=$pw
POSTGRES_DB=app
ENVEOF
  cat > "$ENV_DIR/api.env" <<ENVEOF
ENVIRONMENT=$ENV
DATABASE_URL=postgresql+asyncpg://app:$pw@db:5432/app
ANALYTICS_SALT=$(openssl rand -hex 24)
ROOT_PATH=/api
CORS_ORIGINS=https://$HOST
ENVEOF
fi
umask 022

docker network inspect edge >/dev/null 2>&1 || docker network create edge >/dev/null

if ! docker inspect -f '{{.State.Running}}' caddy 2>/dev/null | grep -q true; then
  docker rm -f caddy >/dev/null 2>&1 || true
  docker run -d --name caddy --restart unless-stopped --network edge \
    -p "127.0.0.1:${AF_HTTP_PORT:-80}:80" \
    -v "$ROOT/caddy:/etc/caddy/conf:ro" \
    -v "$ROOT/sites:/etc/caddy/sites:ro" \
    -v caddy_data:/data \
    caddy:2-alpine caddy run --config /etc/caddy/conf/Caddyfile --adapter caddyfile >/dev/null
fi

export ENV TAG REGISTRY ENV_DIR PG_DATA
compose=(docker compose -p "af-$ENV" -f "$CODE/compose.yml")
[[ -n "${AF_SKIP_PULL:-}" ]] || "${compose[@]}" pull --quiet
"${compose[@]}" up -d --remove-orphans --wait --wait-timeout 180

# Previews get no Access in front of them, so they do not serve the
# unauthenticated admin surfaces at all. `route` keeps the directives in the
# order written; without it Caddy runs handle blocks before respond.
preview_block=""
if [[ "$ENV" != prod ]]; then
  preview_block=$'\t\trespond /admin* 404\n\t\trespond /api/analytics* 404\n'
fi

cat > "$ROOT/sites/$ENV.caddy" <<SITEEOF
http://$HOST {
	route {
$preview_block		redir /app /app/ 308
		redir /admin /admin/ 308
		handle_path /api/* {
			reverse_proxy $ENV-api:8000 {
				# The API reads the first X-Forwarded-For entry as the visitor.
				header_up X-Forwarded-For {client_ip}
			}
		}
		handle_path /app/* {
			reverse_proxy $ENV-dashboard:80
		}
		handle_path /admin/* {
			reverse_proxy $ENV-admin:80
		}
		handle {
			reverse_proxy $ENV-marketing:80
		}
	}
}
SITEEOF

# Directory mount, not a file mount: a copied-over file is a new inode, which a
# single-file bind mount would never show the container.
docker exec caddy caddy reload --config /etc/caddy/conf/Caddyfile --adapter caddyfile
docker image prune -f >/dev/null
echo "deployed $ENV at $TAG to https://$HOST"
echo "HOST=$HOST"
