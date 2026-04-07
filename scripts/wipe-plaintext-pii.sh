#!/bin/bash
# wipe-plaintext-pii.sh — Nulls out plain-text PII columns after verifying hashed/encrypted
# columns are populated. Run ONLY after full testing confirms the system works without plain text.
#
# Usage:
#   ./scripts/wipe-plaintext-pii.sh --dry-run          # Preview affected rows
#   ./scripts/wipe-plaintext-pii.sh --confirm           # Actually wipe plain text
#   ./scripts/wipe-plaintext-pii.sh --dry-run --table sessions  # Preview specific table

set -euo pipefail

# Database connection from environment or defaults
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-pinning_service}"
DB_USER="${POSTGRES_USER:-pinning_user}"
DB_PASS="${POSTGRES_PASSWORD:-}"
PG_CONTAINER="${PG_CONTAINER:-postgres-pinning}"

MODE=""
TABLE_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  MODE="dry-run"; shift ;;
    --confirm)  MODE="confirm"; shift ;;
    --table)    TABLE_FILTER="$2"; shift 2 ;;
    *)          echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Usage: $0 --dry-run | --confirm [--table <name>]"
  echo ""
  echo "  --dry-run   Count affected rows without modifying data"
  echo "  --confirm   Actually wipe plain-text values (irreversible!)"
  echo "  --table     Only process a specific table"
  exit 1
fi

# Run SQL via docker exec or direct psql
run_sql() {
  local sql="$1"
  if command -v docker &>/dev/null && docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "$sql"
  else
    PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -A -c "$sql"
  fi
}

# Wipe helper: verify hashed column is populated, then null the plain-text column
wipe_column() {
  local table="$1"
  local plain_col="$2"
  local hash_col="$3"
  local condition="${4:-}"  # optional extra WHERE condition

  if [[ -n "$TABLE_FILTER" && "$TABLE_FILTER" != "$table" ]]; then
    return
  fi

  local where="$hash_col IS NOT NULL AND $plain_col IS NOT NULL AND $plain_col != ''"
  if [[ -n "$condition" ]]; then
    where="$where AND $condition"
  fi

  if [[ "$MODE" == "dry-run" ]]; then
    local count
    count=$(run_sql "SELECT COUNT(*) FROM $table WHERE $where")
    echo "[dry-run] $table.$plain_col: $count rows would be wiped (verified by $hash_col)"
  else
    local count
    count=$(run_sql "UPDATE $table SET $plain_col = NULL WHERE $where; SELECT COUNT(*) FROM $table WHERE $plain_col IS NULL AND $hash_col IS NOT NULL")
    echo "[wiped]   $table.$plain_col: done"
  fi
}

# Wipe helper for setting to 'REDACTED' instead of NULL (for NOT NULL columns)
redact_column() {
  local table="$1"
  local plain_col="$2"
  local hash_col="$3"

  if [[ -n "$TABLE_FILTER" && "$TABLE_FILTER" != "$table" ]]; then
    return
  fi

  local where="$hash_col IS NOT NULL AND $plain_col IS NOT NULL AND $plain_col != 'REDACTED' AND $plain_col != $hash_col"

  if [[ "$MODE" == "dry-run" ]]; then
    local count
    count=$(run_sql "SELECT COUNT(*) FROM $table WHERE $where")
    echo "[dry-run] $table.$plain_col: $count rows would be redacted (verified by $hash_col)"
  else
    run_sql "UPDATE $table SET $plain_col = 'REDACTED' WHERE $where" >/dev/null
    echo "[redact]  $table.$plain_col: done"
  fi
}

echo "============================================"
echo "PII Wipe Script — Mode: $MODE"
echo "Database: $DB_NAME on $DB_HOST:$DB_PORT"
echo "============================================"
echo ""

if [[ "$MODE" == "confirm" ]]; then
  echo "WARNING: This will irreversibly wipe plain-text PII values."
  echo "         Make sure you have a database backup before proceeding!"
  read -rp "Type 'YES' to continue: " answer
  if [[ "$answer" != "YES" ]]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

# ---- Session tokens ----
# session_token has a UNIQUE constraint, so can't set all to 'REDACTED'.
# Instead, overwrite plain-text token with its hash (already unique).
echo "=== Session Tokens ==="
if [[ -n "$TABLE_FILTER" && "$TABLE_FILTER" != "sessions" ]]; then :
elif [[ "$MODE" == "dry-run" ]]; then
  count=$(run_sql "SELECT COUNT(*) FROM sessions WHERE token_hash IS NOT NULL AND session_token IS NOT NULL AND session_token != token_hash")
  echo "[dry-run] sessions.session_token: $count rows would be overwritten with token_hash"
else
  run_sql "UPDATE sessions SET session_token = token_hash WHERE token_hash IS NOT NULL AND session_token IS NOT NULL AND session_token != token_hash" >/dev/null
  echo "[wiped]   sessions.session_token: done (set to token_hash)"
fi
if [[ -n "$TABLE_FILTER" && "$TABLE_FILTER" != "pins" ]]; then :
elif [[ "$MODE" == "dry-run" ]]; then
  count=$(run_sql "SELECT COUNT(*) FROM pins WHERE token_hash IS NOT NULL AND session_token IS NOT NULL AND session_token != token_hash")
  echo "[dry-run] pins.session_token: $count rows would be overwritten with token_hash"
else
  run_sql "UPDATE pins SET session_token = token_hash WHERE token_hash IS NOT NULL AND session_token IS NOT NULL AND session_token != token_hash" >/dev/null
  echo "[wiped]   pins.session_token: done (set to token_hash)"
fi

# ---- Email addresses ----
echo ""
echo "=== Email Addresses ==="
wipe_column "webui_users"        "email"          "user_id"
wipe_column "api_keys"           "user_email"     "user_id"
wipe_column "user_credits"       "user_email"     "user_id"
wipe_column "credit_history"     "user_email"     "user_id"
wipe_column "referral_codes"     "user_email"     "user_id"
wipe_column "referrals"          "referrer_email" "referrer_id"
wipe_column "referrals"          "referred_email" "referred_id"
wipe_column "token_transactions" "user_email"     "user_id"
wipe_column "user_wallets"       "user_email"     "user_id"
wipe_column "admin_audit_log"    "actor"          "actor_id"
wipe_column "admin_audit_log"    "target_email"   "target_id"
wipe_column "ai_generations"     "user_email"     "user_id"

# ---- Usernames (same as emails) ----
echo ""
echo "=== Usernames ==="
wipe_column "sessions" "username" "user_id"
wipe_column "logins"   "username" "user_id"
wipe_column "pins"     "username" "user_id"
wipe_column "users"    "username" "user_id"

# ---- Wallet addresses ----
echo ""
echo "=== Wallet Addresses ==="
wipe_column "user_wallets" "wallet_address" "encrypted_wallet_address"

# ---- API key plain-text ----
echo ""
echo "=== API Keys ==="
wipe_column "api_keys" "key_id" "encrypted_key"

# ---- IP addresses & user agents (logins) ----
echo ""
echo "=== IP Addresses & User Agents ==="
if [[ -n "$TABLE_FILTER" && "$TABLE_FILTER" != "logins" ]]; then
  : # skip
elif [[ "$MODE" == "dry-run" ]]; then
  count=$(run_sql "SELECT COUNT(*) FROM logins WHERE ip_address IS NOT NULL OR user_agent IS NOT NULL")
  echo "[dry-run] logins.ip_address + user_agent: $count rows would be wiped"
else
  run_sql "UPDATE logins SET ip_address = NULL, user_agent = NULL WHERE ip_address IS NOT NULL OR user_agent IS NOT NULL" >/dev/null
  echo "[wiped]   logins.ip_address + user_agent: done"
fi

echo ""
echo "============================================"
if [[ "$MODE" == "dry-run" ]]; then
  echo "Dry run complete. No data was modified."
  echo "Run with --confirm to actually wipe plain-text values."
else
  echo "Wipe complete. Plain-text PII values have been cleared."
  echo "Verify the system still works before removing this script."
fi
