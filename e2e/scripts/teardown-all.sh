#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$E2E_DIR/deploy"
OUTPUTS_DIR="$E2E_DIR/.outputs"

ALL_PLATFORMS="aws vercel heroku firebase gcp azure render railway flyio digitalocean netlify cloudflare"

usage() {
  echo "Usage: $0 [--platforms aws,vercel,...] [--dry-run]"
  echo ""
  echo "Tear down deployed platforms (reverse of deploy-all)."
  echo ""
  echo "Options:"
  echo "  --platforms   Comma-separated list of platforms (default: all)"
  echo "  --dry-run     Print what would be torn down without running"
  echo "  --help        Show this help"
  echo ""
  echo "Available platforms: $ALL_PLATFORMS"
  exit 0
}

PLATFORMS=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platforms)
      PLATFORMS="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if [[ -z "$PLATFORMS" ]]; then
  PLATFORMS="$ALL_PLATFORMS"
else
  PLATFORMS="${PLATFORMS//,/ }"
fi

echo "=== Tearing down infralift-demo from platforms: $PLATFORMS ==="
echo ""

SUCCESS=()
FAILED=()

for platform in $PLATFORMS; do
  platform_dir="$DEPLOY_DIR/$platform"

  if [[ ! -d "$platform_dir" ]]; then
    echo "[SKIP] $platform - no deploy directory"
    continue
  fi

  teardown_script="$platform_dir/teardown.sh"
  has_terraform=false
  [[ -f "$platform_dir/main.tf" ]] && has_terraform=true

  if [[ ! -f "$teardown_script" ]] && [[ "$has_terraform" == "false" ]]; then
    echo "[SKIP] $platform - no teardown.sh or main.tf found"
    continue
  fi

  if $DRY_RUN; then
    echo "[DRY-RUN] Would tear down: $platform"
    continue
  fi

  echo "--- Tearing down: $platform ---"

  if [[ -f "$teardown_script" ]]; then
    if bash "$teardown_script"; then
      echo "[OK] $platform torn down"
      SUCCESS+=("$platform")
    else
      echo "[FAIL] $platform teardown failed"
      FAILED+=("$platform")
    fi
  elif $has_terraform; then
    (
      cd "$platform_dir"
      terraform init -input=false
      terraform destroy -auto-approve -input=false
    )
    if [[ $? -eq 0 ]]; then
      echo "[OK] $platform torn down"
      SUCCESS+=("$platform")
    else
      echo "[FAIL] $platform teardown failed"
      FAILED+=("$platform")
    fi
  fi

  # Remove output file
  rm -f "$OUTPUTS_DIR/$platform.env"

  echo ""
done

echo "=== Teardown Summary ==="
echo "  Succeeded: ${SUCCESS[*]:-none}"
echo "  Failed:    ${FAILED[*]:-none}"
