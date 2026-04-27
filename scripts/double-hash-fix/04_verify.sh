#!/usr/bin/env bash
# 04_verify.sh — post-commit verification (read-only).
#
# Run AFTER a successful COMMIT in 03_migrate.sh, BEFORE resuming the
# deduction job. Compares post-state against the fingerprint captured
# by 01_backup.sh and runs per-user spot-checks.
#
# Required env vars: PGUSER, PGDB
# Required argument: backup directory from 01_backup.sh
#
# Usage:
#   PGUSER=pinning_user PGDB=pinning_service ./04_verify.sh /var/backups/pinning-service/double-hash-fix-20260427T120000Z

set -euo pipefail

: "${PGUSER:?set PGUSER}"
: "${PGDB:?set PGDB}"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <backup_dir>" >&2
  echo "  e.g.  $0 /var/backups/pinning-service/double-hash-fix-20260427T120000Z" >&2
  exit 2
fi

OUT_DIR="$1"
if [ ! -d "${OUT_DIR}" ]; then
  echo "ERROR: ${OUT_DIR} is not a directory" >&2
  exit 1
fi
if [ ! -f "${OUT_DIR}/fingerprint_pre.txt" ]; then
  echo "ERROR: ${OUT_DIR}/fingerprint_pre.txt missing — was 01_backup.sh run?" >&2
  exit 1
fi

PSQL=(docker exec -i postgres-pinning psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1)

# Re-fingerprint every affected table.
echo "=== Post-migration fingerprint ==="
"${PSQL[@]}" -At <<'SQL' > "${OUT_DIR}/fingerprint_post.txt"
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
cat "${OUT_DIR}/fingerprint_post.txt"
echo ""

echo "=== Diff (pre → post) ==="
echo "Expected differences:"
echo "  • pins         : COUNT and SUM(size) UNCHANGED (only user_id values rotated)"
echo "  • user_credits : COUNT may DROP by the number of merged shadow rows;"
echo "                   the financial sums must be UNCHANGED"
echo "  • credit_history: UNCHANGED counts and sums"
echo "  • Other tables : UNCHANGED counts; user_id distinct count may drop slightly"
echo ""
diff -u "${OUT_DIR}/fingerprint_pre.txt" "${OUT_DIR}/fingerprint_post.txt" \
  || echo "(differences listed above — verify they match the expected pattern)"
echo ""

echo "=== Aggregate invariant checks ==="
"${PSQL[@]}" <<'SQL'
-- These three financial sums must be identical to pre.
SELECT 'post_credits_balance_sum'   AS metric, COALESCE(SUM(balance_fula), 0)         AS v FROM user_credits
UNION ALL SELECT 'post_credits_deposited_sum', COALESCE(SUM(total_deposited_fula), 0) FROM user_credits
UNION ALL SELECT 'post_credits_deducted_sum',  COALESCE(SUM(total_deducted_fula), 0)  FROM user_credits;

-- These two MUST be 0 (both should have been drained by the migration).
SELECT 'post_pins_at_any_shadow'         AS check,
       COUNT(*) AS n
FROM pins p JOIN uid_migration_map m ON p.user_id = m.shadow_id;

SELECT 'post_user_credits_at_any_shadow' AS check,
       COUNT(*) AS n
FROM user_credits uc JOIN uid_migration_map m ON uc.user_id = m.shadow_id;
SQL
echo ""

echo "=== Per-user spot-checks for the reported suspended ids ==="
"${PSQL[@]}" -c "
\echo '--- ehsan (real id 2d2dfffd…41ff) ---'
SELECT 'ehsan_real_credits' AS check, balance_fula, total_deposited_fula,
       total_deducted_fula, is_suspended
FROM user_credits
WHERE user_id = '2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff';

SELECT 'ehsan_shadow_credits_should_be_zero' AS check, COUNT(*) AS n
FROM user_credits
WHERE user_id = 'bf1d001f668c11f95da6c9e78b6d241733a50f201d0deac0549161d2b1d1796c';

SELECT 'ehsan_pins_now_at_real' AS check, COUNT(*) AS rows, COALESCE(SUM(size), 0) AS bytes
FROM pins
WHERE user_id = '2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff'
  AND status != 'deleted';

SELECT 'ehsan_pins_at_shadow_should_be_zero' AS check, COUNT(*) AS n
FROM pins
WHERE user_id = 'bf1d001f668c11f95da6c9e78b6d241733a50f201d0deac0549161d2b1d1796c';

\echo '--- second reported suspended id ---'
SELECT 'second_user_credits_at_shadow_should_be_zero' AS check, COUNT(*) AS n
FROM user_credits
WHERE user_id = '3fd26ed0fa8c266e48cb11267d32cc19ef667444358998452b9ce8de43bcfe28';

SELECT 'second_pins_at_shadow_should_be_zero' AS check, COUNT(*) AS n
FROM pins
WHERE user_id = '3fd26ed0fa8c266e48cb11267d32cc19ef667444358998452b9ce8de43bcfe28';
"
echo ""

cat <<'EOF'
=== OPERATOR — verify before resuming the deduction job ===
  • All three financial sums (balance/deposited/deducted) match pre values
  • post_pins_at_any_shadow            = 0
  • post_user_credits_at_any_shadow    = 0
  • ehsan_shadow_credits_should_be_zero      = 0 rows
  • ehsan_pins_at_shadow_should_be_zero      = 0
  • second_user_credits_at_shadow_should_be_zero = 0 rows
  • second_pins_at_shadow_should_be_zero     = 0
  • ehsan_real_credits.is_suspended  = 0 (or whatever was expected)
  • ehsan_pins_now_at_real           reflects the merged total

If all clear, resume the deduction job. Then run the live FxFiles upload
test to confirm the 402 is gone (Verification step 8 in the plan).
EOF

# Cleanup: 02_inspect.sh created a persistent uid_migration_map table in the
# public schema. Once verification passes there's no further need for it.
# Operator confirms before we drop, so they can keep it for further analysis
# if desired.
echo ""
echo "=== Cleanup ==="
echo "02_inspect.sh created a persistent table 'uid_migration_map' containing"
echo "the real_id ↔ shadow_id pairs used for the migration. Drop it now?"
echo -n "  Type 'yes' to drop, anything else to keep: "
read -r REPLY
if [ "${REPLY}" = "yes" ]; then
  "${PSQL[@]}" -c "DROP TABLE IF EXISTS uid_migration_map;"
  echo "  Dropped uid_migration_map."
else
  echo "  Kept uid_migration_map. Drop manually later with:"
  echo "    docker exec -i postgres-pinning psql -U ${PGUSER} -d ${PGDB} -c 'DROP TABLE uid_migration_map;'"
fi
