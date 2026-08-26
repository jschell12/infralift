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
  echo "Deploy the reference app to specified platforms (or all)."
  echo ""
  echo "Options:"
  echo "  --platforms   Comma-separated list of platforms (default: all)"
  echo "  --dry-run     Print what would be deployed without running"
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

# Default to all platforms if none specified
if [[ -z "$PLATFORMS" ]]; then
  PLATFORMS="$ALL_PLATFORMS"
else
  PLATFORMS="${PLATFORMS//,/ }"
fi

# Create outputs directory
mkdir -p "$OUTPUTS_DIR"

# Add .outputs to .gitignore if not already there
GITIGNORE="$E2E_DIR/../.gitignore"
if [[ -f "$GITIGNORE" ]]; then
  if ! grep -q "^e2e/\.outputs" "$GITIGNORE" 2>/dev/null; then
    echo "" >> "$GITIGNORE"
    echo "# E2E deployment outputs (secrets)" >> "$GITIGNORE"
    echo "e2e/.outputs/" >> "$GITIGNORE"
    echo "e2e/.results/" >> "$GITIGNORE"
  fi
fi

echo "=== Deploying infralift-demo to platforms: $PLATFORMS ==="
echo ""

SUCCESS=()
FAILED=()

for platform in $PLATFORMS; do
  platform_dir="$DEPLOY_DIR/$platform"

  if [[ ! -d "$platform_dir" ]]; then
    echo "[SKIP] $platform - no deploy directory found at $platform_dir"
    continue
  fi

  deploy_script="$platform_dir/deploy.sh"
  has_terraform=false
  [[ -f "$platform_dir/main.tf" ]] && has_terraform=true

  if [[ ! -f "$deploy_script" ]] && [[ "$has_terraform" == "false" ]]; then
    echo "[SKIP] $platform - no deploy.sh or main.tf found"
    continue
  fi

  if $DRY_RUN; then
    echo "[DRY-RUN] Would deploy: $platform"
    continue
  fi

  echo "--- Deploying: $platform ---"

  output_file="$OUTPUTS_DIR/$platform.env"

  if [[ -f "$deploy_script" ]]; then
    if bash "$deploy_script" > "$output_file" 2>&1; then
      echo "[OK] $platform deployed"
      SUCCESS+=("$platform")
    else
      echo "[FAIL] $platform - see $output_file for details"
      FAILED+=("$platform")
    fi
  elif $has_terraform; then
    (
      cd "$platform_dir"
      terraform init -input=false
      terraform apply -auto-approve -input=false
      echo "# Terraform outputs for $platform" > "$output_file"
      terraform output -json >> "$output_file"
    ) 2>&1 | tee -a "$output_file"
    if [[ ${PIPESTATUS[0]} -eq 0 ]]; then
      echo "[OK] $platform deployed"
      SUCCESS+=("$platform")
    else
      echo "[FAIL] $platform - see $output_file for details"
      FAILED+=("$platform")
    fi
  fi

  echo ""
done

echo "=== Deployment Summary ==="
echo "  Succeeded: ${SUCCESS[*]:-none}"
echo "  Failed:    ${FAILED[*]:-none}"
echo "  Outputs:   $OUTPUTS_DIR/"
