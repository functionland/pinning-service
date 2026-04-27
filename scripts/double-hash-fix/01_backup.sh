#!/usr/bin/env bash
# 01_backup.sh — full database backup before the double-hash data fix.
#
# Run AFTER pausing the deduction job and AFTER deploying the new
# pinning-service binary, but BEFORE running 02_inspect.sh / 03_migrate.sh.
# Captures the actual pre-migration state so that any restore reaches a
# clean known state with no gap of unbacked-up writes.
#
# Required env vars:
#   PGUSER  — postgres user (e.g. pinning_user)
#   PGDB    — postgres database (e.g. pinning_service)
#
# Optional:
#   BACKUP_ROOT — defaults to /var/backups/pinning-service
#
# Usage:
#   PGUSER=pinning_user PGDB=pinning_service ./01_backup.sh
#
# On success prints the backup directory path. Save it — 04_verify.sh needs it.

set -euo pipefail

: "${PGUSER:?set PGUSER}"
: "${PGDB:?set PGDB}"

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/pinning-service}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT_DIR="${BACKUP_ROOT}/double-hash-fix-${TS}"

mkdir -p "${OUT_DIR}"
echo "Backup directory: ${OUT_DIR}"
echo ""

# Full database dump (custom format, compressed, restorable with pg_restore).
echo "=== Full database dump (custom format) ==="
docker exec postgres-pinning pg_dump \
  -U "${PGUSER}" -d "${PGDB}" \
  --format=custom --compress=9 --no-owner \
  > "${OUT_DIR}/full_${PGDB}.dump"
echo "Wrote ${OUT_DIR}/full_${PGDB}.dump"
echo ""

# Plain-SQL per-table dumps for human review / spot-restore of one table.
echo "=== Per-table data-only dumps ==="
for T in pins user_credits credit_history sessions users webui_users \
         api_keys referral_codes token_transactions user_wallets \
         logins ai_generations; do
  docker exec postgres-pinning pg_dump \
    -U "${PGUSER}" -d "${PGDB}" --table="${T}" --data-only \
    > "${OUT_DIR}/${T}.sql"
  echo "  ${T}: $(wc -l < "${OUT_DIR}/${T}.sql") lines"
done
echo ""

# Hash-fingerprint each table — counts and sums for fast pre/post comparison.
echo "=== Pre-migration fingerprint ==="
docker exec -i postgres-pinning psql -U "${PGUSER}" -d "${PGDB}" -At <<'SQL' \
  > "${OUT_DIR}/fingerprint_pre.txt"
SELECT 'pins',          COUNT(*), COALESCE(SUM(size), 0) FROM pins;
SELECT 'user_credits',  COUNT(*),
       COALESCE(SUM(balance_fula), 0)::text || '|' ||
       COALESCE(SUM(total_deposited_fula), 0)::text || '|' ||
       COALESCE(SUM(total_deducted_fula), 0)::text
FROM user_credits;
SELECT 'credit_history', COUNT(*), COALESCE(SUM(amount_fula), 0) FROM credit_history;
SELECT 'sessions',       COUNT(*), COUNT(DISTINCT user_id)        FROM sessions;
SELECT 'users',          COUNT(*), COUNT(DISTINCT user_id)        FROM users;
SELECT 'webui_users',    COUNT(*), COUNT(DISTINCT user_id)        FROM webui_users;
SELECT 'api_keys',       COUNT(*), COUNT(DISTINCT user_id)        FROM api_keys;
SELECT 'referral_codes', COUNT(*), COUNT(DISTINCT user_id)        FROM referral_codes;
SELECT 'token_transactions', COUNT(*), COUNT(DISTINCT user_id)    FROM token_transactions;
SELECT 'user_wallets',   COUNT(*), COUNT(DISTINCT user_id)        FROM user_wallets;
SELECT 'logins',         COUNT(*), COUNT(DISTINCT user_id)        FROM logins;
SELECT 'ai_generations', COUNT(*), COUNT(DISTINCT user_id)        FROM ai_generations;
SQL
cat "${OUT_DIR}/fingerprint_pre.txt"
echo ""

# Sanity: backup file must be non-trivial size.
SIZE=$(stat -c %s "${OUT_DIR}/full_${PGDB}.dump")
if [ "${SIZE}" -lt 1000000 ]; then
  echo "ERROR: backup file is suspiciously small (${SIZE} bytes). Aborting." >&2
  exit 1
fi

# Compute and store an overall checksum for tamper-detection later.
sha256sum "${OUT_DIR}/full_${PGDB}.dump" > "${OUT_DIR}/full_${PGDB}.dump.sha256"

echo "=== Backup complete ==="
echo "  Size:      ${SIZE} bytes"
echo "  SHA-256:   $(cat "${OUT_DIR}/full_${PGDB}.dump.sha256" | awk '{print $1}')"
echo "  Directory: ${OUT_DIR}"
echo ""
echo "To restore the full dump if needed:"
echo "  docker exec -i postgres-pinning pg_restore -U ${PGUSER} -d ${PGDB} \\"
echo "    --clean --if-exists < ${OUT_DIR}/full_${PGDB}.dump"
echo ""
echo "Save this path. 04_verify.sh expects it as its first argument."
echo "  export BACKUP_DIR=${OUT_DIR}"
