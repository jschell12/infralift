#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUTS_DIR="$E2E_DIR/.outputs"
RESULTS_DIR="$E2E_DIR/.results"

API_URL="${API_URL:-https://dashboard.infralift.dev/api}"

usage() {
  echo "Usage: $0 [--platforms aws,vercel,...] [--api-url URL]"
  echo ""
  echo "Run infralift assessments against deployed platforms."
  echo ""
  echo "Options:"
  echo "  --platforms   Comma-separated list of platforms (default: all with saved outputs)"
  echo "  --api-url     Infralift API URL (default: $API_URL)"
  echo "  --help        Show this help"
  exit 0
}

FILTER_PLATFORMS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platforms)
      FILTER_PLATFORMS="$2"
      shift 2
      ;;
    --api-url)
      API_URL="$2"
      shift 2
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

if [[ -n "$FILTER_PLATFORMS" ]]; then
  FILTER_PLATFORMS="${FILTER_PLATFORMS//,/ }"
fi

# Check for saved outputs
if [[ ! -d "$OUTPUTS_DIR" ]]; then
  echo "ERROR: No outputs directory found at $OUTPUTS_DIR"
  echo "Run deploy-all.sh first to deploy platforms."
  exit 1
fi

mkdir -p "$RESULTS_DIR"

echo "=== Running infralift assessments ==="
echo "API: $API_URL"
echo ""

SUCCESS=()
FAILED=()
SKIPPED=()

for output_file in "$OUTPUTS_DIR"/*.env; do
  [[ -f "$output_file" ]] || continue

  platform=$(basename "$output_file" .env)

  # Apply platform filter if specified
  if [[ -n "$FILTER_PLATFORMS" ]]; then
    if ! echo "$FILTER_PLATFORMS" | grep -qw "$platform"; then
      continue
    fi
  fi

  echo "--- Assessing: $platform ---"

  # Extract app URL from output file (handles both shell env and JSON formats)
  app_url=""
  if grep -q '"app_url"' "$output_file" 2>/dev/null; then
    # JSON format (terraform output -json)
    app_url=$(grep -o '"app_url"[^}]*"value"[^"]*"[^"]*"' "$output_file" | grep -o '"value".*' | cut -d'"' -f4 || true)
  fi
  if [[ -z "$app_url" ]]; then
    # Shell format or plain text
    app_url=$(grep -i 'app.url\|APP_URL\|worker_url\|WORKER_URL' "$output_file" | tail -1 | sed 's/.*=\s*//' | tr -d '"' || true)
  fi

  if [[ -z "$app_url" ]]; then
    echo "[SKIP] $platform - could not extract app URL from $output_file"
    SKIPPED+=("$platform")
    echo ""
    continue
  fi

  echo "  App URL: $app_url"

  # Step 1: Create a connection
  echo "  Creating connection..."
  connection_response=$(curl -sf -X POST "$API_URL/connections" \
    -H "Content-Type: application/json" \
    -d "{
      \"provider\": \"$platform\",
      \"appUrl\": \"$app_url\",
      \"name\": \"e2e-$platform\"
    }" 2>&1) || {
    echo "[FAIL] $platform - could not create connection"
    echo "  Response: $connection_response"
    FAILED+=("$platform")
    echo ""
    continue
  }

  connection_id=$(echo "$connection_response" | jq -r '.id // .connectionId // empty')
  if [[ -z "$connection_id" ]]; then
    echo "[FAIL] $platform - no connection ID in response"
    echo "  Response: $connection_response"
    FAILED+=("$platform")
    echo ""
    continue
  fi

  echo "  Connection ID: $connection_id"

  # Step 2: Run an assessment
  echo "  Running assessment..."
  assessment_response=$(curl -sf -X POST "$API_URL/assessments" \
    -H "Content-Type: application/json" \
    -d "{
      \"connectionId\": \"$connection_id\",
      \"provider\": \"$platform\"
    }" 2>&1) || {
    echo "[FAIL] $platform - could not create assessment"
    echo "  Response: $assessment_response"
    FAILED+=("$platform")
    echo ""
    continue
  }

  assessment_id=$(echo "$assessment_response" | jq -r '.id // .assessmentId // empty')
  echo "  Assessment ID: $assessment_id"

  # Step 3: Poll for completion (max 60 seconds)
  echo "  Waiting for assessment to complete..."
  for i in $(seq 1 12); do
    sleep 5
    status_response=$(curl -sf "$API_URL/assessments/$assessment_id" 2>&1) || continue
    status=$(echo "$status_response" | jq -r '.status // "unknown"')
    if [[ "$status" == "completed" || "$status" == "complete" ]]; then
      break
    elif [[ "$status" == "failed" || "$status" == "error" ]]; then
      echo "[FAIL] $platform - assessment failed"
      echo "$status_response" | jq . > "$RESULTS_DIR/$platform.json"
      FAILED+=("$platform")
      continue 2
    fi
    echo "  Status: $status (attempt $i/12)"
  done

  # Save the result
  result_file="$RESULTS_DIR/$platform.json"
  if [[ -n "${status_response:-}" ]]; then
    echo "$status_response" | jq . > "$result_file"
  else
    echo "$assessment_response" | jq . > "$result_file"
  fi

  echo "[OK] $platform - assessment saved to $result_file"
  SUCCESS+=("$platform")
  echo ""
done

echo "=== Assessment Summary ==="
echo "  Succeeded: ${SUCCESS[*]:-none}"
echo "  Failed:    ${FAILED[*]:-none}"
echo "  Skipped:   ${SKIPPED[*]:-none}"
echo "  Results:   $RESULTS_DIR/"
