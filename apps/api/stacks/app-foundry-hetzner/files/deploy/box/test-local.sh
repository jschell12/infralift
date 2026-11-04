#!/usr/bin/env bash
# Runs the box layer for real against locally built images: deploy a
# preview, check every route through Caddy, take a backup, restore it into a
# scratch Postgres, tear the preview down. Needs Docker; touches nothing
# remote. Run from the repo root: deploy/box/test-local.sh
set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d)
PORT="${AF_HTTP_PORT:-8088}"
ENV=pr-0
HOST_TEMPLATE="preview-{slot}.localhost"
HOST=preview-1.localhost
TAG=local
REG=localhost/af-test

# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  AF_ROOT="$WORK" "$WORK/code/$ENV/bin/teardown.sh" "$ENV" >/dev/null 2>&1 || true
  docker rm -f caddy af-restore-check >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if docker inspect caddy >/dev/null 2>&1; then
  echo "a container named caddy already exists; refusing to touch it" >&2
  exit 1
fi

echo "== building images"
docker build -q -t "$REG/app-foundry-api:$TAG" -f "$REPO/infra/docker/api.Dockerfile" "$REPO" >/dev/null
for spec in marketing:/ dashboard:/app/ admin:/admin/; do
  app=${spec%%:*} base=${spec#*:}
  docker build -q -t "$REG/app-foundry-$app:$TAG" -f "$REPO/infra/docker/web.Dockerfile" \
    --build-arg APP="$app" --build-arg VITE_API_URL=/api --build-arg VITE_BASE="$base" "$REPO" >/dev/null
done

mkdir -p "$WORK/code/$ENV"
cp -R "$REPO/deploy/box/." "$WORK/code/$ENV/"
BIN="$WORK/code/$ENV/bin"
export AF_ROOT="$WORK" AF_HTTP_PORT="$PORT" AF_SKIP_PULL=1

echo "== deploy $ENV"
out=$("$BIN/deploy.sh" "$ENV" "$HOST_TEMPLATE" "$TAG" "$REG")
echo "$out"
fail=0
if [[ "$(tail -1 <<<"$out")" == "HOST=$HOST" ]]; then echo "ok   first preview took slot 1"; else echo "FAIL expected HOST=$HOST" >&2; fail=1; fi

check() { # check <path> <expected status> [body substring]
  local out code
  out=$(curl -s -H "Host: $HOST" -w '\n%{http_code}' "http://127.0.0.1:$PORT$1")
  code=${out##*$'\n'}
  if [[ "$code" != "$2" ]] || { [[ -n "${3:-}" ]] && [[ "$out" != *"$3"* ]]; }; then
    echo "FAIL $1: got $code, want $2${3:+ containing \"$3\"}" >&2; fail=1
  else
    echo "ok   $1 -> $code"
  fi
}
check /api/health 200 '"database":"ok"'
check /api/docs 200 '/api/openapi.json'
check / 200 '<div id="root">'
check /app/ 200 '/app/assets/'
check /app 308
check /admin/ 404
check /admin 404
check /api/analytics/summary 404
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: unknown.localhost' "http://127.0.0.1:$PORT/")
if [[ "$code" == 404 ]]; then echo "ok   unknown host -> 404"; else echo "FAIL unknown host: $code" >&2; fail=1; fi

echo "== Caddyfile edits take effect (directory mount, not a stale inode)"
sed 's/respond 404/respond "edited" 404/' "$WORK/code/$ENV/Caddyfile" > "$WORK/caddy/Caddyfile.new"
mv "$WORK/caddy/Caddyfile.new" "$WORK/caddy/Caddyfile"
docker exec caddy caddy reload --config /etc/caddy/conf/Caddyfile --adapter caddyfile
check / 200 '<div id="root">'
body=$(curl -s -H 'Host: unknown.localhost' "http://127.0.0.1:$PORT/")
if [[ "$body" == edited ]]; then echo "ok   edited Caddyfile is live"; else echo "FAIL Caddy still serving the old Caddyfile ($body)" >&2; fail=1; fi

echo "== the visitor's IP reaches the API (two IPs, two visitor hashes)"
# cloudflared hands Caddy the visitor's address in Cf-Connecting-Ip.
for ip in 203.0.113.7 198.51.100.9; do
  curl -s -o /dev/null -H "Host: $HOST" -H "Cf-Connecting-Ip: $ip" -H 'Content-Type: text/plain' \
    -H 'User-Agent: Mozilla/5.0 test-local' --data '{"p":"/","r":"","q":""}' "http://127.0.0.1:$PORT/api/a/e"
done
visitors=$(docker exec "af-$ENV-db-1" psql -U app -d app -tAc 'select count(distinct visitor_hash) from analytics_events')
if [[ "$visitors" == 2 ]]; then echo "ok   2 IPs counted as 2 visitors"; else echo "FAIL 2 IPs counted as $visitors visitor(s)" >&2; fail=1; fi

echo "== backup and restore"
"$BIN/backup.sh" "$ENV" > "$WORK/db.dump"
test -s "$WORK/db.dump"
docker run -d --name af-restore-check -e POSTGRES_PASSWORD=x -e POSTGRES_DB=app postgres:17-alpine >/dev/null
for _ in $(seq 30); do docker exec af-restore-check pg_isready -U postgres -d app >/dev/null 2>&1 && break; sleep 1; done
sleep 2
docker exec -i af-restore-check pg_restore -U postgres -d app --no-owner --exit-on-error < "$WORK/db.dump"
rows=$(docker exec af-restore-check psql -U postgres -d app -tAc 'select count(*) from analytics_events')
echo "ok   restored dump has $rows analytics_events row(s)"
[[ "$rows" -ge 2 ]] || { echo "FAIL expected both test events in the restored dump" >&2; fail=1; }

echo "== teardown"
"$BIN/teardown.sh" "$ENV"
if [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=af-$ENV")" ]]; then
  echo "ok   no af-$ENV containers left"
else
  echo "FAIL af-$ENV containers still exist" >&2; fail=1
fi

exit $fail
