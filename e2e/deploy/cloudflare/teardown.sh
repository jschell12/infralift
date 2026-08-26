#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Destroying Cloudflare E2E infrastructure..."
echo "NOTE: This does not destroy the Neon database. Delete it separately at neon.tech."
terraform destroy -auto-approve

echo "Teardown complete."
