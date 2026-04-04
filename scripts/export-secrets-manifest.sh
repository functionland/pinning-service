#!/bin/bash
# export-secrets-manifest.sh — Exports env var names + SHA-256 fingerprints (NOT values).
#
# Used by the restore procedure to verify all required secrets are available
# before attempting a full restore. The manifest contains only names and
# fingerprints — never actual secret values.
#
# Usage:
#   ./scripts/export-secrets-manifest.sh > secrets-manifest.json
#   ./scripts/export-secrets-manifest.sh --verify secrets-manifest.json

set -euo pipefail

# All secrets used across services
REQUIRED_SECRETS=(
  "JWT_SECRET"
  "SESSION_SECRET"
  "ENCRYPTION_KEY"
  "PINNING_SYSTEM_KEY"
  "POSTGRES_PASSWORD"
  "BACKUP_ENCRYPTION_KEY"
)

OPTIONAL_SECRETS=(
  "S3_ADMIN_TOKEN"
  "S3_ADMIN_JWT"
  "CLAUDE_API_KEY"
  "GOOGLE_CLIENT_ID"
  "APPLE_CLIENT_ID"
  "APPLE_TEAM_ID"
  "APPLE_KEY_ID"
  "ETHERSCAN_API_KEY"
  "FACILITATOR_URL"
  "RECEIVING_ADDRESS"
  "VAULT_ADDRESS"
)

fingerprint() {
  local val="${1:-}"
  if [[ -n "$val" ]]; then
    echo -n "$val" | sha256sum | cut -d' ' -f1
  else
    echo "NOT_SET"
  fi
}

if [[ "${1:-}" == "--verify" ]]; then
  # Verify mode: check that current env matches a manifest
  MANIFEST="${2:?Usage: $0 --verify <manifest.json>}"
  if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required for verification"
    exit 1
  fi

  echo "Verifying secrets against manifest: $MANIFEST"
  ERRORS=0

  for name in $(jq -r '.secrets[].name' "$MANIFEST"); do
    expected=$(jq -r --arg n "$name" '.secrets[] | select(.name == $n) | .fingerprint' "$MANIFEST")
    required=$(jq -r --arg n "$name" '.secrets[] | select(.name == $n) | .required' "$MANIFEST")
    actual=$(fingerprint "${!name:-}")

    if [[ "$expected" == "NOT_SET" && "$actual" == "NOT_SET" ]]; then
      if [[ "$required" == "true" ]]; then
        echo "  MISSING (required): $name"
        ERRORS=$((ERRORS + 1))
      else
        echo "  SKIP (optional, not set): $name"
      fi
    elif [[ "$expected" == "$actual" ]]; then
      echo "  OK: $name"
    elif [[ "$actual" == "NOT_SET" ]]; then
      echo "  MISSING: $name (was set in backup)"
      if [[ "$required" == "true" ]]; then
        ERRORS=$((ERRORS + 1))
      fi
    else
      echo "  CHANGED: $name (fingerprint differs — rotated?)"
    fi
  done

  if [[ $ERRORS -gt 0 ]]; then
    echo ""
    echo "FAILED: $ERRORS required secret(s) missing."
    exit 1
  else
    echo ""
    echo "All required secrets verified."
    exit 0
  fi
fi

# Export mode: generate manifest
echo "{"
echo "  \"generated_at\": \"$(date -Iseconds)\","
echo "  \"secrets\": ["

FIRST=true
for name in "${REQUIRED_SECRETS[@]}"; do
  if [[ "$FIRST" != "true" ]]; then echo ","; fi
  FIRST=false
  fp=$(fingerprint "${!name:-}")
  printf '    {"name": "%s", "required": true, "fingerprint": "%s", "is_set": %s}' \
    "$name" "$fp" "$( [[ "$fp" != "NOT_SET" ]] && echo "true" || echo "false" )"
done

for name in "${OPTIONAL_SECRETS[@]}"; do
  echo ","
  fp=$(fingerprint "${!name:-}")
  printf '    {"name": "%s", "required": false, "fingerprint": "%s", "is_set": %s}' \
    "$name" "$fp" "$( [[ "$fp" != "NOT_SET" ]] && echo "true" || echo "false" )"
done

echo ""
echo "  ]"
echo "}"
