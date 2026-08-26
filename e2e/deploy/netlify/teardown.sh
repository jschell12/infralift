#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Destroying Netlify E2E infrastructure (DNS zone + env vars)..."
echo "NOTE: This does not delete the Netlify site or the Neon database."
echo "Delete the site at app.netlify.com and the database at neon.tech."
terraform destroy -auto-approve

echo "Teardown complete."
