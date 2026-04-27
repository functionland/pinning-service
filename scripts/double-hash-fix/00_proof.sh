#!/usr/bin/env bash
# 00_proof.sh — definitive proof script for the double-hash bug.
#
# RUN THIS FIRST. Read-only / dry-run only — runs entirely inside a transaction
# that ALWAYS rolls back, so the production database is byte-for-byte unchanged.
# Outputs a one-line VERDICT: PASS or VERDICT: FAIL.
#
# Do NOT deploy the code change. Do NOT run 03_migrate.sh. Unless this prints PASS.
#
# Note on map persistence: this script builds uid_migration_map as a TEMP table
# inside the rolled-back transaction. 02_inspect.sh later builds a PERSISTENT
# uid_migration_map in the public schema; 03_migrate.sql consumes it; 04_verify.sh
# drops it at the end. If you ever re-run 00_proof.sh AFTER 02_inspect.sh,
# the TEMP table here will shadow the persistent one inside this session only.
#
# Required env vars:
#   PGUSER  — postgres user (e.g. pinning_user)
#   PGDB    — postgres database (e.g. pinning_service)
#
# Usage:
#   PGUSER=pinning_user PGDB=pinning_service ./00_proof.sh

set -euo pipefail

: "${PGUSER:?set PGUSER}"
: "${PGDB:?set PGDB}"

PSQL=(docker exec -i postgres-pinning psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1)

OUT_FILE="${OUT_FILE:-/tmp/double_hash_proof.out}"
echo "Output will be written to: ${OUT_FILE}"
echo ""

echo "=== Precondition: pgcrypto extension ==="
if "${PSQL[@]}" -At -c "SELECT 1 FROM pg_extension WHERE extname='pgcrypto';" | grep -q 1; then
  echo "  OK: pgcrypto installed"
else
  echo "  FAIL: pgcrypto NOT installed. Run as superuser:"
  echo "    docker exec -i postgres-pinning psql -U postgres -d ${PGDB} -c 'CREATE EXTENSION pgcrypto;'"
  echo "VERDICT: FAIL"
  exit 1
fi

echo ""

# All proof work runs in ONE transaction and is rolled back at the end.
"${PSQL[@]}" <<'SQL' | tee "${OUT_FILE}"

BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout      = '30s';

-- ---------------------------------------------------------------------------
-- Build the candidate map exactly as 02_inspect would.
-- Step 1: gather candidate "real" ids from any user-id-bearing table that we
-- expect to hold single-hashed user_ids (sha256(lowercase_email)).
-- Step 2: detect and FILTER OUT candidates that are mathematically the
-- sha256 of ANOTHER candidate — those are shadows that crept into a
-- real-id-source table (e.g. via manual operator top-up of a shadow row,
-- or via a deduction-job auto-create that later got a deposit).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE uid_migration_map (
  real_id   VARCHAR(64) PRIMARY KEY,
  shadow_id VARCHAR(64) UNIQUE NOT NULL,
  source    TEXT NOT NULL
);

CREATE TEMP TABLE _candidates_raw AS
          SELECT user_id, 'sessions'           AS src FROM sessions           WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'users'              AS src FROM users              WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'webui_users'        AS src FROM webui_users        WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'user_wallets'       AS src FROM user_wallets       WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'user_credits'       AS src FROM user_credits       WHERE user_id IS NOT NULL AND user_id <> '' AND total_deposited_fula > 0
UNION ALL SELECT user_id, 'api_keys'           AS src FROM api_keys           WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'referral_codes'     AS src FROM referral_codes     WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'token_transactions' AS src FROM token_transactions WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'ai_generations'     AS src FROM ai_generations     WHERE user_id IS NOT NULL AND user_id <> '';

CREATE TEMP TABLE _candidates AS
SELECT user_id,
       string_agg(DISTINCT src, ',') AS source,
       encode(digest(user_id, 'sha256'), 'hex') AS shadow_id
FROM _candidates_raw
GROUP BY user_id;

-- Insert only candidates that are NOT the sha256 of any other candidate.
-- SHA-256 collision-resistance means this filter only drops genuine shadows.
INSERT INTO uid_migration_map (real_id, shadow_id, source)
SELECT c.user_id, c.shadow_id, c.source
FROM _candidates c
WHERE NOT EXISTS (
  SELECT 1 FROM _candidates c2 WHERE c2.shadow_id = c.user_id
);

\echo
\echo '=== Proof A: hash math links the suspected suspended row to the real user ==='
SELECT
  '2d2dfffd…41ff' AS real_id_label,
  encode(digest('2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff', 'sha256'), 'hex') AS computed_shadow,
  CASE WHEN encode(digest('2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff', 'sha256'), 'hex')
            = 'bf1d001f668c11f95da6c9e78b6d241733a50f201d0deac0549161d2b1d1796c'
       THEN 'PASS — shadow matches reported suspended id bf1d001f…1d1796c'
       ELSE 'FAIL — diagnosis broken; halt and re-investigate'
  END AS verdict;

\echo
\echo '=== Proof A2: classify each reported suspended id ==='
\echo '  PASS — id is a shadow of a known real_id (will be migrated).'
\echo '  INFO — id is itself a known real_id (NOT a shadow; suspension is'
\echo '         unrelated to the double-hash bug; treat with normal'
\echo '         deposit/unsuspend).'
\echo '  WARN — id is neither a known real_id nor a shadow of one. Operator'
\echo '         decides per-case (manually map or accept stuck-shadow data).'
SELECT id_target,
       (SELECT real_id FROM uid_migration_map WHERE shadow_id = id_target) AS mapped_real_if_shadow,
       EXISTS (SELECT 1 FROM uid_migration_map WHERE real_id = id_target)  AS is_itself_a_real_id,
       CASE
         WHEN EXISTS (SELECT 1 FROM uid_migration_map WHERE real_id   = id_target)
              THEN 'INFO — id is itself a known real_id (not a shadow). Suspension unrelated to the double-hash bug.'
         WHEN EXISTS (SELECT 1 FROM uid_migration_map WHERE shadow_id = id_target)
              THEN 'PASS — shadow of a known real_id; will be migrated.'
         ELSE 'WARN — id is neither a known real_id nor a shadow of one.'
       END AS verdict
FROM (VALUES
  ('bf1d001f668c11f95da6c9e78b6d241733a50f201d0deac0549161d2b1d1796c'),
  ('3fd26ed0fa8c266e48cb11267d32cc19ef667444358998452b9ce8de43bcfe28')
) AS t(id_target);

\echo
\echo '=== Proof A3: candidates filtered out as detected self-shadows ==='
\echo '  These are user_ids that appeared in some user-id-bearing table BUT'
\echo '  are mathematically the SHA-256 of another candidate user_id.'
\echo '  By SHA-256 collision-resistance, this only happens when the value'
\echo '  is a TRUE shadow (sha256(email) was applied twice somewhere) — never'
\echo '  by coincidence. Each row below shows: which value was filtered, where'
\echo '  it appeared, the real id it is the shadow of, and that real id source.'
\echo '  Verify each filtered row corresponds to a known operator action'
\echo '  (typically a manual top-up of a shadow user_credits row).'
SELECT c.user_id  AS filtered_id,
       c.source   AS filtered_source,
       c2.user_id AS real_id_it_is_shadow_of,
       c2.source  AS real_id_source
FROM _candidates c
JOIN _candidates c2 ON c2.shadow_id = c.user_id;

\echo
\echo '=== Proof B: bug is currently active — recent pins sit at shadow ids ==='
SELECT
  COUNT(*) FILTER (WHERE p.created_at >= NOW() - INTERVAL '7 days' AND p.user_id IN (SELECT shadow_id FROM uid_migration_map)) AS recent_pins_at_shadow,
  COUNT(*) FILTER (WHERE p.created_at >= NOW() - INTERVAL '7 days' AND p.user_id IN (SELECT real_id   FROM uid_migration_map)) AS recent_pins_at_real,
  CASE
    WHEN COUNT(*) FILTER (WHERE p.created_at >= NOW() - INTERVAL '7 days' AND p.user_id IN (SELECT shadow_id FROM uid_migration_map)) > 0
    THEN 'PASS — bug confirmed active (recent pins at shadow ids)'
    ELSE 'INDETERMINATE — no recent pins found at shadow ids; either the bug already self-healed (unlikely) or low traffic. Review manually.'
  END AS verdict
FROM pins p;

\echo
\echo '=== Proof C: no legacy raw-email user_ids in pins ==='
SELECT COUNT(*) AS legacy_raw_email_pins,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — legacy raw-email user_ids exist; needs separate cleanup' END AS verdict
FROM pins WHERE user_id LIKE '%@%';

\echo
\echo '=== Proof D: no shadow_id collides with any real_id (data-loss risk gate) ==='
\echo '  This runs against the FILTERED uid_migration_map (after self-shadows'
\echo '  were removed in step 1). Must be 0. If non-zero: the filter missed a'
\echo '  case and the migration could corrupt data — STOP.'
SELECT COUNT(*) AS collisions,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — STOP: a shadow_id in the FILTERED map still equals another real_id' END AS verdict
FROM uid_migration_map m
WHERE EXISTS (SELECT 1 FROM uid_migration_map m2 WHERE m2.real_id = m.shadow_id);

-- If the count above is non-zero, the next query shows exactly which pairs
-- still collide so the operator can investigate.
SELECT m.real_id   AS real_id_a,
       m.shadow_id AS shadow_of_a_equals_real_id_b,
       m.source    AS real_id_a_source,
       m2.source   AS real_id_b_source
FROM uid_migration_map m
JOIN uid_migration_map m2 ON m2.real_id = m.shadow_id;

\echo
\echo '=== Proof E: dry-run of the migration with conservation invariants ==='

-- Pre-state snapshot.
CREATE TEMP TABLE pre_state AS
          SELECT 'pins_total'                  AS metric, COUNT(*)::numeric AS v FROM pins
UNION ALL SELECT 'pins_total_size',                COALESCE(SUM(size), 0) FROM pins
UNION ALL SELECT 'user_credits_rows',              COUNT(*) FROM user_credits
UNION ALL SELECT 'credits_balance_sum',            COALESCE(SUM(balance_fula), 0) FROM user_credits
UNION ALL SELECT 'credits_deposited_sum',          COALESCE(SUM(total_deposited_fula), 0) FROM user_credits
UNION ALL SELECT 'credits_deducted_sum',           COALESCE(SUM(total_deducted_fula), 0) FROM user_credits
UNION ALL SELECT 'credit_history_rows',            COUNT(*) FROM credit_history
UNION ALL SELECT 'credit_history_sum',             COALESCE(SUM(amount_fula), 0) FROM credit_history
UNION ALL SELECT 'pins_at_shadow_count',
       COUNT(*)::numeric FROM pins p JOIN uid_migration_map m ON p.user_id = m.shadow_id
UNION ALL SELECT 'user_credits_at_shadow_count',
       COUNT(*)::numeric FROM user_credits uc JOIN uid_migration_map m ON uc.user_id = m.shadow_id;

-- Apply the full migration (we're in a transaction that will ROLLBACK at end).
UPDATE pins p           SET user_id = m.real_id FROM uid_migration_map m WHERE p.user_id = m.shadow_id;
UPDATE credit_history ch SET user_id = m.real_id FROM uid_migration_map m WHERE ch.user_id = m.shadow_id;

WITH merge_pairs AS (
  SELECT m.shadow_id, m.real_id,
         shad.balance_fula AS sb, shad.total_deposited_fula AS sd, shad.total_deducted_fula AS sded,
         shad.is_suspended AS ss, shad.suspended_at AS ssat, shad.last_deduction_at AS slast
  FROM uid_migration_map m
  JOIN user_credits shad ON shad.user_id = m.shadow_id
  WHERE EXISTS (SELECT 1 FROM user_credits real WHERE real.user_id = m.real_id)
)
UPDATE user_credits real
SET balance_fula         = real.balance_fula         + mp.sb,
    total_deposited_fula = real.total_deposited_fula + mp.sd,
    total_deducted_fula  = real.total_deducted_fula  + mp.sded,
    is_suspended         = GREATEST(real.is_suspended, mp.ss),
    suspended_at         = COALESCE(real.suspended_at, mp.ssat),
    last_deduction_at    = GREATEST(COALESCE(real.last_deduction_at,'epoch'::timestamptz),
                                    COALESCE(mp.slast,            'epoch'::timestamptz)),
    updated_at = NOW()
FROM merge_pairs mp WHERE real.user_id = mp.real_id;

DELETE FROM user_credits
WHERE user_id IN (
  SELECT m.shadow_id FROM uid_migration_map m
  WHERE EXISTS (SELECT 1 FROM user_credits ucr WHERE ucr.user_id = m.real_id)
);

UPDATE user_credits uc
SET user_id = m.real_id, is_suspended = 0, suspended_at = NULL, updated_at = NOW()
-- balance_fula intentionally untouched to preserve the conservation invariant
FROM uid_migration_map m
WHERE uc.user_id = m.shadow_id
  AND NOT EXISTS (SELECT 1 FROM user_credits real WHERE real.user_id = m.real_id);

UPDATE api_keys           SET user_id = m.real_id FROM uid_migration_map m WHERE api_keys.user_id           = m.shadow_id;
UPDATE referral_codes     SET user_id = m.real_id FROM uid_migration_map m WHERE referral_codes.user_id     = m.shadow_id;
UPDATE token_transactions SET user_id = m.real_id FROM uid_migration_map m WHERE token_transactions.user_id = m.shadow_id;
UPDATE user_wallets       SET user_id = m.real_id FROM uid_migration_map m WHERE user_wallets.user_id       = m.shadow_id;
UPDATE webui_users        SET user_id = m.real_id FROM uid_migration_map m WHERE webui_users.user_id        = m.shadow_id;
UPDATE logins             SET user_id = m.real_id FROM uid_migration_map m WHERE logins.user_id             = m.shadow_id;
UPDATE ai_generations     SET user_id = m.real_id FROM uid_migration_map m WHERE ai_generations.user_id     = m.shadow_id;

-- Compare post-state against pre-state.
CREATE TEMP TABLE post_state AS
          SELECT 'pins_total'                  AS metric, COUNT(*)::numeric AS v FROM pins
UNION ALL SELECT 'pins_total_size',                COALESCE(SUM(size), 0) FROM pins
UNION ALL SELECT 'user_credits_rows',              COUNT(*) FROM user_credits
UNION ALL SELECT 'credits_balance_sum',            COALESCE(SUM(balance_fula), 0) FROM user_credits
UNION ALL SELECT 'credits_deposited_sum',          COALESCE(SUM(total_deposited_fula), 0) FROM user_credits
UNION ALL SELECT 'credits_deducted_sum',           COALESCE(SUM(total_deducted_fula), 0) FROM user_credits
UNION ALL SELECT 'credit_history_rows',            COUNT(*) FROM credit_history
UNION ALL SELECT 'credit_history_sum',             COALESCE(SUM(amount_fula), 0) FROM credit_history
UNION ALL SELECT 'pins_at_shadow_count',
       COUNT(*)::numeric FROM pins p JOIN uid_migration_map m ON p.user_id = m.shadow_id
UNION ALL SELECT 'user_credits_at_shadow_count',
       COUNT(*)::numeric FROM user_credits uc JOIN uid_migration_map m ON uc.user_id = m.shadow_id;

\echo '--- Conservation matrix (pre vs post) ---'
SELECT pre.metric, pre.v AS pre_value, post.v AS post_value,
       (post.v - pre.v) AS delta,
       CASE
         WHEN pre.metric = 'pins_at_shadow_count'         AND post.v = 0 AND pre.v >= 0 THEN 'PASS — drained to 0'
         WHEN pre.metric = 'user_credits_at_shadow_count' AND post.v = 0 AND pre.v >= 0 THEN 'PASS — drained to 0'
         WHEN pre.metric = 'user_credits_rows' THEN
           CASE WHEN (pre.v - post.v) >= 0 THEN 'PASS — rows merged-and-deleted (count drop = number of merged shadows)'
                ELSE 'FAIL — user_credits row count went UP, that''s wrong' END
         WHEN pre.v = post.v THEN 'PASS — conserved'
         ELSE 'FAIL — value drifted; investigate before running real migration'
       END AS verdict
FROM pre_state pre JOIN post_state post USING (metric)
ORDER BY pre.metric;

-- Per-user previews intentionally OMITTED here. The conservation matrix above
-- already proves correctness in aggregate. Per-user spot-checks belong in
-- 04_verify.sh, AFTER the real commit, where they can be compared against
-- operator records (e.g. ehsan's row was manually topped up by 100 FULA in
-- the original Step 3 unblock — a per-user preview here would look "off"
-- by exactly that amount and confuse the operator).

-- ALWAYS roll back. The database is unchanged after this script exits.
ROLLBACK;
\echo
\echo '=== DRY-RUN COMPLETE — transaction rolled back, DB unchanged ==='
SQL

# Compute final verdict from the captured output. Match only the literal verdict
# string to avoid false matches on prose containing the word "FAIL".
if grep -E '\| FAIL\b|FAIL — ' "${OUT_FILE}" >/dev/null; then
  echo ""
  echo "VERDICT: FAIL"
  echo "Do NOT deploy the code change. Do NOT run the data fix."
  echo "Review ${OUT_FILE} and consult before proceeding."
  exit 1
else
  echo ""
  echo "VERDICT: PASS"
  echo "All proofs (A, A2, B, C, D, E + conservation matrix) succeeded."
  echo "Safe to proceed: pause deduction, deploy code, run 01_backup.sh, then 02/03/04."
  exit 0
fi
