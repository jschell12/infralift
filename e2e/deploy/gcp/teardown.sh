#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Destroying GCP E2E infrastructure..."
terraform destroy -auto-approve

echo "Teardown complete."
