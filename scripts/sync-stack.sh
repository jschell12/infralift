#!/usr/bin/env bash
# sync-stack.sh <app-foundry checkout> [slug]
#
# Re-vendors a stack's verbatim files from the repo it was built from, and
# records the source commit in stack.json. The rendered files (templates/)
# are not touched: diff the source's main.tf/backend.tf against them by hand,
# and refresh src/lib/stacks/__fixtures__ so the golden test keeps proving
# the templates reproduce the source exactly.
set -euo pipefail

SRC=$(cd "$1" && pwd)
SLUG=${2:-app-foundry-hetzner}
ROOT=$(git rev-parse --show-toplevel)
DEST="$ROOT/apps/api/stacks/$SLUG/files"

[[ -z "$(git -C "$SRC" status --porcelain)" ]] || { echo "$SRC has uncommitted changes" >&2; exit 1; }
SHA=$(git -C "$SRC" rev-parse HEAD)

rm -rf "$DEST" && mkdir -p "$DEST"
git -C "$SRC" ls-files deploy .github/actions \
  .github/workflows/build.yml .github/workflows/deploy.yml .github/workflows/preview.yml \
  .github/workflows/backup.yml .github/workflows/infra.yml |
  grep -vE '^deploy/README.md$|^deploy/infra/(main|backend)\.tf$|^deploy/infra/backends/|^deploy/infra/backend\.r2\.hcl\.example$|^deploy/bootstrap/main\.tf$|\.lock\.hcl$' |
  while read -r f; do
    mkdir -p "$DEST/$(dirname "$f")"
    cp -p "$SRC/$f" "$DEST/$f"
  done

python3 - "$ROOT/apps/api/stacks/$SLUG/stack.json" "$SHA" <<'PY'
import json, sys
p, sha = sys.argv[1], sys.argv[2]
m = json.load(open(p))
m["source"]["commit"] = sha
open(p, "w").write(json.dumps(m, indent=2) + "\n")
PY
cp "$SRC/deploy/infra/main.tf" "$SRC/deploy/infra/backend.tf" "$ROOT/apps/api/src/lib/stacks/__fixtures__/$SLUG/"
echo "synced $SLUG from $SHA; now run: pnpm --filter @infralift/api test && pnpm --filter @infralift/api validate:stacks"
