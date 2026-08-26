#!/usr/bin/env bash
set -euo pipefail

echo "=== Tearing down infralift-demo on Railway ==="

: "${RAILWAY_TOKEN:?Set RAILWAY_TOKEN}"

export RAILWAY_TOKEN

# Link to the project if not already linked
# (railway delete operates on the linked project)
echo "Deleting Railway project and all services..."
railway delete --yes

echo "=== Teardown complete ==="
echo "The Railway project, Postgres plugin, and all associated resources have been removed."
