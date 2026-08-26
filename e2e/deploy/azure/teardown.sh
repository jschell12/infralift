#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Destroying Azure E2E infrastructure..."
terraform destroy -auto-approve

echo "Teardown complete."
