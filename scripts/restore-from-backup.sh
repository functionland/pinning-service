#!/bin/bash
# restore-from-backup.sh — Full server restoration from IPFS-backed database backup.
#
# Resolves the latest backup from IPNS, decrypts the dump, and restores PostgreSQL.
# Optionally restores the fula-api registry CID from its separate IPNS key.
#
# Usage:
#   ./scripts/restore-from-backup.sh                    # Interactive restore
#   ./scripts/restore-from-backup.sh --manifest-cid <CID>  # Restore specific backup
#   ./scripts/restore-from-backup.sh --list             # List backup history from IPNS chain
#
# Required environment:
#   BACKUP_ENCRYPTION_KEY  — Must match the key used during backup
#
# Optional environment:
#   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
#   PG_CONTAINER, IPFS_CONTAINER, IPNS_KEY, REGISTRY_IPNS_KEY

set -euo pipefail

# Configuration
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-pinning_service}"
DB_USER="${POSTGRES_USER:-pinning_user}"
DB_PASS="${POSTGRES_PASSWORD:-}"
PG_CONTAINER="${PG_CONTAINER:-postgres-pinning}"
IPFS_CONTAINER="${IPFS_CONTAINER:-ipfs_host}"
IPNS_KEY="${IPNS_KEY:-fula-db-backup}"
REGISTRY_IPNS_KEY="${REGISTRY_IPNS_KEY:-fula-registry}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/fula-gateway}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/opt/pinning-service/migrations/postgres}"

MANIFEST_CID=""
LIST_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-cid) MANIFEST_CID="$2"; shift 2 ;;
    --list)         LIST_MODE=true; shift ;;
    *)              echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate encryption key
if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
  echo "FATAL: BACKUP_ENCRYPTION_KEY not set"
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Helper: fetch and decrypt from IPFS
ipfs_cat_decrypt() {
  local cid="$1"
  local outfile="$2"
  docker exec "$IPFS_CONTAINER" ipfs cat "$cid" | \
    openssl enc -aes-256-cbc -d -salt -pbkdf2 -iter 100000 \
      -pass "env:BACKUP_ENCRYPTION_KEY" > "$outfile"
}

# Helper: run SQL
run_sql() {
  local sql="$1"
  if command -v docker &>/dev/null && docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "$sql"
  else
    PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "$sql"
  fi
}

# ============================================
# Resolve latest manifest from IPNS
# ============================================
if [[ -z "$MANIFEST_CID" ]]; then
  echo "Resolving latest backup from IPNS (key=$IPNS_KEY)..."
  IPNS_NAME=$(docker exec "$IPFS_CONTAINER" ipfs key list -l | grep "$IPNS_KEY" | awk '{print $1}')
  if [[ -z "$IPNS_NAME" ]]; then
    echo "ERROR: IPNS key '$IPNS_KEY' not found. Has a backup ever been published?"
    exit 1
  fi
  RESOLVED=$(docker exec "$IPFS_CONTAINER" ipfs name resolve "/ipns/$IPNS_NAME" 2>&1) || {
    echo "ERROR: Failed to resolve IPNS: $RESOLVED"
    exit 1
  }
  MANIFEST_CID=$(echo "$RESOLVED" | sed 's|^/ipfs/||')
  echo "Resolved manifest CID: $MANIFEST_CID"
fi

# ============================================
# Fetch and decrypt manifest
# ============================================
echo "Fetching manifest..."
MANIFEST_FILE="$TMPDIR/manifest.json"
ipfs_cat_decrypt "$MANIFEST_CID" "$MANIFEST_FILE"

if ! command -v jq &>/dev/null; then
  echo "Manifest contents:"
  cat "$MANIFEST_FILE"
  echo ""
  echo "WARNING: jq not installed — cannot parse manifest automatically"
else
  echo "Backup details:"
  jq '.' "$MANIFEST_FILE"
  echo ""
fi

# List mode: walk the backup chain
if [[ "$LIST_MODE" == true ]]; then
  echo "=== Backup History ==="
  current="$MANIFEST_FILE"
  i=1
  while true; do
    ts=$(jq -r '.timestamp' "$current" 2>/dev/null || echo "unknown")
    dcid=$(jq -r '.dump_cid' "$current" 2>/dev/null || echo "unknown")
    size=$(jq -r '.dump_size_bytes' "$current" 2>/dev/null || echo "unknown")
    prev=$(jq -r '.prev_backup_cid // empty' "$current" 2>/dev/null || true)
    echo "  #$i: $ts — dump=$dcid (${size} bytes)"
    if [[ -z "$prev" || "$prev" == "null" ]]; then
      break
    fi
    i=$((i + 1))
    next_file="$TMPDIR/manifest-$i.json"
    ipfs_cat_decrypt "$prev" "$next_file" 2>/dev/null || {
      echo "  (could not fetch older backup: $prev)"
      break
    }
    current="$next_file"
    if [[ $i -gt 30 ]]; then
      echo "  (stopped at 30 entries)"
      break
    fi
  done
  exit 0
fi

# ============================================
# Confirm restore
# ============================================
DUMP_CID=$(jq -r '.dump_cid' "$MANIFEST_FILE" 2>/dev/null || echo "")
if [[ -z "$DUMP_CID" ]]; then
  echo "ERROR: Could not parse dump_cid from manifest"
  exit 1
fi

echo ""
echo "WARNING: This will DROP and recreate the database '$DB_NAME'."
echo "         All existing data will be replaced with the backup."
read -rp "Type 'RESTORE' to continue: " answer
if [[ "$answer" != "RESTORE" ]]; then
  echo "Aborted."
  exit 0
fi

# ============================================
# Fetch and decrypt dump
# ============================================
echo ""
echo "Fetching and decrypting dump ($DUMP_CID)..."
DUMP_FILE="$TMPDIR/restore.dump"
ipfs_cat_decrypt "$DUMP_CID" "$DUMP_FILE"

# Verify dump
if pg_restore --list "$DUMP_FILE" >/dev/null 2>&1; then
  TABLE_COUNT=$(pg_restore --list "$DUMP_FILE" 2>/dev/null | grep -c "TABLE DATA" || true)
  echo "Dump verified: $TABLE_COUNT tables"
else
  echo "ERROR: Dump verification failed — file may be corrupt"
  exit 1
fi

# ============================================
# Restore database
# ============================================
echo "Dropping and recreating database..."
if command -v docker &>/dev/null && docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" 2>/dev/null || true
  docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
  docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  docker exec -i "$PG_CONTAINER" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl < "$DUMP_FILE"
else
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" 2>/dev/null || true
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  PGPASSWORD="$DB_PASS" pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl "$DUMP_FILE"
fi

echo "Database restored successfully."

# ============================================
# Run pending migrations
# ============================================
SCHEMA_VERSION=$(jq -r '.schema_version // "unknown"' "$MANIFEST_FILE" 2>/dev/null || echo "unknown")
if [[ -d "$MIGRATIONS_DIR" ]]; then
  CURRENT_MIGRATIONS=$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l)
  echo "Backup schema version: $SCHEMA_VERSION, current migrations: $CURRENT_MIGRATIONS"
  if [[ "$SCHEMA_VERSION" != "unknown" && "$CURRENT_MIGRATIONS" -gt "$SCHEMA_VERSION" ]]; then
    echo "Running pending migrations..."
    for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort | tail -n +$((SCHEMA_VERSION + 1))); do
      echo "  Applying: $(basename "$f")"
      if command -v docker &>/dev/null && docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
        docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < "$f"
      else
        PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$f"
      fi
    done
  fi
else
  echo "Migrations directory not found at $MIGRATIONS_DIR — skipping"
fi

# ============================================
# Restore registry CID from IPNS (fula-api)
# ============================================
echo ""
echo "Restoring fula-api registry CID..."
REG_IPNS_NAME=$(docker exec "$IPFS_CONTAINER" ipfs key list -l | grep "$REGISTRY_IPNS_KEY" | awk '{print $1}' || true)
if [[ -n "$REG_IPNS_NAME" ]]; then
  REG_RESOLVED=$(docker exec "$IPFS_CONTAINER" ipfs name resolve "/ipns/$REG_IPNS_NAME" 2>&1) || true
  if [[ "$REG_RESOLVED" == /ipfs/* ]]; then
    REG_CID=$(echo "$REG_RESOLVED" | sed 's|^/ipfs/||')
    echo "$REG_CID" > "${BACKUP_DIR}/registry.cid"
    echo "Registry CID restored: $REG_CID"
  else
    echo "WARNING: Could not resolve registry IPNS — fula-api may need manual configuration"
  fi
else
  echo "WARNING: Registry IPNS key '$REGISTRY_IPNS_KEY' not found"
fi

# ============================================
# Summary
# ============================================
echo ""
echo "============================================"
echo "Restore complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Verify secrets are set: ./scripts/export-secrets-manifest.sh --verify <manifest>"
echo "  2. Start services in order:"
echo "     a. PostgreSQL (already running)"
echo "     b. IPFS daemon + cluster"
echo "     c. fula-pinning-service (Go)"
echo "     d. fula-upload-server (ipfs-server)"
echo "     e. fula-pinning-webui"
echo "     f. fula-api gateway"
echo "     g. x402-gateway"
echo "     h. fula-ai-service"
echo "  3. Verify health: curl http://localhost:3001/api/health"
