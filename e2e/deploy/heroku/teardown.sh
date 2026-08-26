#!/usr/bin/env bash
set -euo pipefail

echo "=== Tearing down infralift-demo on Heroku ==="

: "${HEROKU_APP:?Set HEROKU_APP to the Heroku app name to destroy}"
: "${HEROKU_API_KEY:?Set HEROKU_API_KEY (or log in with heroku auth:login)}"

echo "Destroying app: $HEROKU_APP (including all addons)"
heroku apps:destroy "$HEROKU_APP" --confirm "$HEROKU_APP"

echo "=== Teardown complete ==="
