#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Validating all Terraform configurations under e2e/ ==="
echo ""

SUCCESS=()
FAILED=()

# Find all directories containing main.tf or shared.tf under e2e/
while IFS= read -r tf_file; do
  tf_dir=$(dirname "$tf_file")
  rel_dir="${tf_dir#$E2E_DIR/}"

  echo "--- Validating: $rel_dir ---"

  (
    cd "$tf_dir"
    terraform init -backend=false -input=false > /dev/null 2>&1
    terraform validate
  )

  if [[ $? -eq 0 ]]; then
    echo "[OK] $rel_dir"
    SUCCESS+=("$rel_dir")
  else
    echo "[FAIL] $rel_dir"
    FAILED+=("$rel_dir")
  fi

  echo ""
done < <(find "$E2E_DIR" -name 'main.tf' -o -name 'shared.tf' | sort)

echo "=== Validation Summary ==="
echo "  Passed: ${#SUCCESS[@]}"
echo "  Failed: ${#FAILED[@]}"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo ""
  echo "  Failed directories:"
  for f in "${FAILED[@]}"; do
    echo "    - $f"
  done
  exit 1
fi
