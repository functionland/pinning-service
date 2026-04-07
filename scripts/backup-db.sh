#!/bin/bash
# backup-db.sh — Encrypted PostgreSQL backup to IPFS with IPNS publishing.
#
# Flow: pg_dump -> encrypt (AES-256-CBC + PBKDF2) -> IPFS add -> IPNS publish
# Mirrors the existing publish-registry-ipns.sh pattern for the registry CID.
#
# One-time setup:
#   docker exec ipfs_host ipfs key gen fula-db-backup
#
# Cron entry (daily at 3 AM):
#   0 3 * * * /opt/pinning-service/scripts/backup-db.sh >> /var/log/fula-db-backup.log 2>&1
#
# Required environment:
#   BACKUP_ENCRYPTION_KEY  — AES-256 key for dump encryption (openssl rand -hex 32)
#   POSTGRES_PASSWORD      — Database password (or use .pgpass)
#
# Optional environment:
#   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER
#   PG_CONTAINER           — Docker container name for PostgreSQL (default: postgres-pinning)
#   IPFS_CONTAINER         — Docker container name for IPFS (default: ipfs_host)
#   IPNS_KEY               — IPNS key name for publishing (default: fula-db-backup)

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
BACKUP_DIR="${BACKUP_DIR:-/var/lib/fula-gateway}"
HISTORY_FILE="${BACKUP_DIR}/backup-history.json"
CID_FILE="${BACKUP_DIR}/db-backup.cid"
TIMESTAMP=$(date -Iseconds)
DATE_TAG=$(date +%Y%m%d-%H%M%S)

# Validate encryption key
if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
  echo "$(date -Iseconds) FATAL: BACKUP_ENCRYPTION_KEY not set"
  echo "  Generate one with: openssl rand -hex 32"
  exit 1
fi

# Temp files (cleaned up on exit)
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

DUMP_FILE="$TMPDIR/backup-${DATE_TAG}.dump"
ENC_FILE="$TMPDIR/backup-${DATE_TAG}.dump.enc"
MANIFEST_FILE="$TMPDIR/manifest-${DATE_TAG}.json"
ENC_MANIFEST="$TMPDIR/manifest-${DATE_TAG}.json.enc"

echo "$(date -Iseconds) Starting database backup..."

# ============================================
# Step 1: pg_dump (custom format, compressed)
# ============================================
echo "$(date -Iseconds) Dumping database..."

# Exclude ephemeral tables from backup
EXCLUDE_TABLES=(
  "--exclude-table-data=logins"  # PII: IP addresses, user agents (30-day auto-cleanup)
)

if command -v docker &>/dev/null && docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  docker exec "$PG_CONTAINER" pg_dump \
    -U "$DB_USER" -d "$DB_NAME" \
    -Fc -Z6 \
    "${EXCLUDE_TABLES[@]}" \
    > "$DUMP_FILE"
else
  PGPASSWORD="$DB_PASS" pg_dump \
    -h "$DB_HOST" -p "$DB_PORT" \
    -U "$DB_USER" -d "$DB_NAME" \
    -Fc -Z6 \
    "${EXCLUDE_TABLES[@]}" \
    > "$DUMP_FILE"
fi

DUMP_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
echo "$(date -Iseconds) Dump complete: ${DUMP_SIZE} bytes"

# ============================================
# Step 2: Encrypt with AES-256-GCM
# ============================================
echo "$(date -Iseconds) Encrypting dump..."
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 \
  -pass "env:BACKUP_ENCRYPTION_KEY" \
  -in "$DUMP_FILE" -out "$ENC_FILE"

ENC_SIZE=$(stat -c%s "$ENC_FILE" 2>/dev/null || stat -f%z "$ENC_FILE")
echo "$(date -Iseconds) Encrypted: ${ENC_SIZE} bytes"

# ============================================
# Step 3: Upload encrypted dump to IPFS
# ============================================
echo "$(date -Iseconds) Adding encrypted dump to IPFS..."
DUMP_CID=$(docker exec -i "$IPFS_CONTAINER" ipfs add --pin=true --quieter < "$ENC_FILE")
echo "$(date -Iseconds) Dump CID: $DUMP_CID"

# ============================================
# Step 4: Read previous backup CID (for linked list)
# ============================================
PREV_CID=""
if [[ -f "$CID_FILE" ]]; then
  PREV_CID=$(cat "$CID_FILE" 2>/dev/null | tr -d '[:space:]') || true
fi

# Get current migration version (count migration files)
SCHEMA_VERSION=$(ls /opt/pinning-service/migrations/postgres/*.sql 2>/dev/null | wc -l || echo "unknown")

# ============================================
# Step 4b: Export IPNS key (encrypted) for disaster recovery
# ============================================
IPNS_KEY_FILE="$TMPDIR/ipns-key.key"
IPNS_KEY_ENC="$TMPDIR/ipns-key.key.enc"
IPNS_KEY_CID=""
if docker exec "$IPFS_CONTAINER" ipfs key export "$IPNS_KEY" > "$IPNS_KEY_FILE" 2>/dev/null && [[ -s "$IPNS_KEY_FILE" ]]; then
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 \
    -pass "env:BACKUP_ENCRYPTION_KEY" \
    -in "$IPNS_KEY_FILE" -out "$IPNS_KEY_ENC"
  IPNS_KEY_CID=$(docker exec -i "$IPFS_CONTAINER" ipfs add --pin=true --quieter < "$IPNS_KEY_ENC")
  echo "$(date -Iseconds) IPNS key backed up: $IPNS_KEY_CID"
else
  echo "$(date -Iseconds) WARNING: Could not export IPNS key"
fi

# ============================================
# Step 4c: Export secrets manifest (encrypted)
# ============================================
SECRETS_CID=""
if [[ -x "/opt/pinning-service/scripts/export-secrets-manifest.sh" ]]; then
  SECRETS_FILE="$TMPDIR/secrets-manifest.json"
  /opt/pinning-service/scripts/export-secrets-manifest.sh > "$SECRETS_FILE" 2>/dev/null || true
  if [[ -s "$SECRETS_FILE" ]]; then
    ENC_SECRETS="$TMPDIR/secrets-manifest.json.enc"
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 \
      -pass "env:BACKUP_ENCRYPTION_KEY" \
      -in "$SECRETS_FILE" -out "$ENC_SECRETS"
    SECRETS_CID=$(docker exec -i "$IPFS_CONTAINER" ipfs add --pin=true --quieter < "$ENC_SECRETS")
    echo "$(date -Iseconds) Secrets manifest: $SECRETS_CID"
  fi
fi

# ============================================
# Step 5: Build and encrypt manifest
# ============================================
cat > "$MANIFEST_FILE" <<MANIFEST_EOF
{
  "version": 2,
  "timestamp": "${TIMESTAMP}",
  "dump_cid": "${DUMP_CID}",
  "dump_size_bytes": ${DUMP_SIZE},
  "encrypted_size_bytes": ${ENC_SIZE},
  "schema_version": "${SCHEMA_VERSION}",
  "encryption": "aes-256-cbc-pbkdf2",
  "pbkdf2_iterations": 600000,
  "pii_status": "remediated",
  "excluded_tables": ["logins"],
  "prev_backup_cid": "${PREV_CID:-null}",
  "ipns_key_cid": "${IPNS_KEY_CID:-null}",
  "secrets_manifest_cid": "${SECRETS_CID:-null}"
}
MANIFEST_EOF

openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 \
  -pass "env:BACKUP_ENCRYPTION_KEY" \
  -in "$MANIFEST_FILE" -out "$ENC_MANIFEST"

MANIFEST_CID=$(docker exec -i "$IPFS_CONTAINER" ipfs add --pin=true --quieter < "$ENC_MANIFEST")
echo "$(date -Iseconds) Manifest CID: $MANIFEST_CID"

# ============================================
# Step 6: Publish manifest to IPNS
# ============================================
echo "$(date -Iseconds) Publishing to IPNS (key=$IPNS_KEY)..."
IPNS_OUTPUT=$(docker exec "$IPFS_CONTAINER" ipfs name publish \
  --key="$IPNS_KEY" \
  --lifetime=25h \
  --quieter \
  "/ipfs/$MANIFEST_CID" 2>&1) || {
  echo "$(date -Iseconds) ERROR: IPNS publish failed: $IPNS_OUTPUT"
  exit 1
}

echo "$(date -Iseconds) Published to /ipns/$IPNS_OUTPUT"

# ============================================
# Step 7: Update local state
# ============================================
echo "$MANIFEST_CID" > "$CID_FILE"

# Append to backup history
mkdir -p "$(dirname "$HISTORY_FILE")"
if [[ ! -f "$HISTORY_FILE" ]]; then
  echo "[]" > "$HISTORY_FILE"
fi

# Add entry to history (use python for JSON manipulation, or jq if available)
if command -v jq &>/dev/null; then
  jq --arg ts "$TIMESTAMP" \
     --arg mc "$MANIFEST_CID" \
     --arg dc "$DUMP_CID" \
     --argjson ds "$DUMP_SIZE" \
     --arg ik "${IPNS_KEY_CID:-}" \
     '. += [{"timestamp": $ts, "manifest_cid": $mc, "dump_cid": $dc, "dump_size": $ds, "ipns_key_cid": $ik}]' \
     "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
else
  # Fallback: append as text
  echo "{\"timestamp\":\"$TIMESTAMP\",\"manifest_cid\":\"$MANIFEST_CID\",\"dump_cid\":\"$DUMP_CID\",\"dump_size\":$DUMP_SIZE}" >> "${HISTORY_FILE}.log"
fi

# ============================================
# Step 8: Verify backup
# ============================================
echo "$(date -Iseconds) Verifying backup..."
VERIFY_FILE="$TMPDIR/verify.dump"
docker exec "$IPFS_CONTAINER" ipfs cat "$DUMP_CID" | \
  openssl enc -aes-256-cbc -d -salt -pbkdf2 -iter 600000 \
    -pass "env:BACKUP_ENCRYPTION_KEY" > "$VERIFY_FILE" 2>/dev/null

if pg_restore --list "$VERIFY_FILE" >/dev/null 2>&1; then
  TABLE_COUNT=$(pg_restore --list "$VERIFY_FILE" 2>/dev/null | grep -c "TABLE DATA" || true)
  echo "$(date -Iseconds) Verification OK: $TABLE_COUNT tables in dump"
else
  echo "$(date -Iseconds) WARNING: Backup verification failed — dump may be corrupt"
  exit 1
fi

# ============================================
# Step 9: Retention cleanup (unpin old backups)
# ============================================
if command -v jq &>/dev/null && [[ -f "$HISTORY_FILE" ]]; then
  TOTAL=$(jq length "$HISTORY_FILE")
  # Keep last 7 dailies, unpin older ones
  if [[ "$TOTAL" -gt 7 ]]; then
    CUTOFF=$(date -d "7 days ago" -Iseconds 2>/dev/null || date -v-7d -Iseconds 2>/dev/null || echo "")
    if [[ -n "$CUTOFF" ]]; then
      TO_UNPIN=$(jq -r --arg cutoff "$CUTOFF" \
        '[.[] | select(.timestamp < $cutoff)] | .[:-4] | .[].dump_cid' \
        "$HISTORY_FILE" 2>/dev/null || true)
      for cid in $TO_UNPIN; do
        docker exec "$IPFS_CONTAINER" ipfs pin rm "$cid" 2>/dev/null && \
          echo "$(date -Iseconds) Unpinned old backup: $cid" || true
      done
    fi
  fi
fi

echo "$(date -Iseconds) Backup complete."
echo "  Manifest: $MANIFEST_CID"
echo "  Dump:     $DUMP_CID ($DUMP_SIZE bytes)"
echo "  IPNS:     /ipns/$IPNS_OUTPUT"
