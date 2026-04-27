-- ===========================================================================
-- 03_migrate.sql — transactional double-hash data migration.
--
-- Paste this file BLOCK BY BLOCK into the interactive psql session opened by
-- 03_migrate.sh. Read every verification result between blocks. The session
-- runs inside ONE transaction with savepoints; only when every check passes
-- does the operator type COMMIT; manually.
--
-- Prerequisites:
--   • 00_proof.sh   printed VERDICT: PASS
--   • Deduction job is paused
--   • New pinning-service binary is deployed
--   • 01_backup.sh  completed and the dump SHA-256 is recorded
--   • 02_inspect.sh all integrity gates passed
--   • Table uid_migration_map exists (built by 02_inspect.sh)
-- ===========================================================================

-- ===========================================================================
-- PHASE 0 — open transaction; snapshot pre-state; re-validate gates.
-- ===========================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout      = '30s';

CREATE TEMP TABLE pre_snapshot AS
          SELECT 'pins_total'                  AS metric, COUNT(*)::numeric AS v FROM pins
UNION ALL SELECT 'pins_total_size',                COALESCE(SUM(size), 0)        FROM pins
UNION ALL SELECT 'user_credits_rows',              COUNT(*)                      FROM user_credits
UNION ALL SELECT 'user_credits_balance_sum',       COALESCE(SUM(balance_fula), 0)         FROM user_credits
UNION ALL SELECT 'user_credits_deposited_sum',     COALESCE(SUM(total_deposited_fula), 0) FROM user_credits
UNION ALL SELECT 'user_credits_deducted_sum',      COALESCE(SUM(total_deducted_fula), 0)  FROM user_credits
UNION ALL SELECT 'credit_history_rows',            COUNT(*)                      FROM credit_history
UNION ALL SELECT 'credit_history_amount_sum',      COALESCE(SUM(amount_fula), 0) FROM credit_history
UNION ALL SELECT 'pins_at_shadow_count',
       COUNT(*)::numeric FROM pins p JOIN uid_migration_map m ON p.user_id = m.shadow_id
UNION ALL SELECT 'user_credits_at_shadow_count',
       COUNT(*)::numeric FROM user_credits uc JOIN uid_migration_map m ON uc.user_id = m.shadow_id;

-- Operator records these. They are the conservation invariants.
TABLE pre_snapshot;

-- Re-run shadow-collides-with-real check inside the transaction.
SELECT 'CHECK_collision_shadow_eq_real' AS check, COUNT(*) AS n
FROM uid_migration_map m
WHERE EXISTS (SELECT 1 FROM uid_migration_map m2 WHERE m2.real_id = m.shadow_id);
-- Must be 0. Otherwise type: ROLLBACK;

-- Pre-merge balance review — last chance to catch an unwanted balance drop.
SELECT m.real_id,
       shad.balance_fula AS shadow_bal,
       real.balance_fula AS real_bal,
       real.balance_fula + shad.balance_fula AS post_merge_bal,
       shad.is_suspended AS shad_sus,
       real.is_suspended AS real_sus
FROM uid_migration_map m
JOIN user_credits shad ON shad.user_id = m.shadow_id
JOIN user_credits real ON real.user_id = m.real_id
ORDER BY post_merge_bal ASC;
-- If any post_merge_bal is unexpectedly negative or any real_bal would drop
-- sharply, type: ROLLBACK; and adjust per-user before retry.


-- ===========================================================================
-- PHASE 1 — re-link pins.user_id (shadow → real).
-- ===========================================================================
SAVEPOINT phase_1_pins;

WITH updated AS (
  UPDATE pins p
  SET user_id = m.real_id
  FROM uid_migration_map m
  WHERE p.user_id = m.shadow_id
  RETURNING 1
)
SELECT 'phase_1_rows_updated' AS metric, COUNT(*) AS v FROM updated;
-- Must equal pre_snapshot.pins_at_shadow_count.

SELECT 'pins_total_after_p1'      AS metric, COUNT(*)::numeric       AS v FROM pins
UNION ALL SELECT 'pins_total_size_after_p1', COALESCE(SUM(size), 0)  FROM pins;
-- Must equal pre_snapshot.pins_total and pins_total_size respectively.
-- Drift? Type: ROLLBACK TO SAVEPOINT phase_1_pins;

SELECT 'pins_at_shadow_after_p1' AS metric, COUNT(*) AS v
FROM pins p JOIN uid_migration_map m ON p.user_id = m.shadow_id;
-- Must be 0.


-- ===========================================================================
-- PHASE 2 — re-link credit_history.user_id (shadow → real).
-- ===========================================================================
SAVEPOINT phase_2_credit_history;

WITH updated AS (
  UPDATE credit_history ch
  SET user_id = m.real_id
  FROM uid_migration_map m
  WHERE ch.user_id = m.shadow_id
  RETURNING 1
)
SELECT 'phase_2_rows_updated' AS metric, COUNT(*) AS v FROM updated;

SELECT 'credit_history_rows_after_p2'        AS metric, COUNT(*)::numeric            AS v FROM credit_history
UNION ALL SELECT 'credit_history_amount_sum_after_p2', COALESCE(SUM(amount_fula), 0) FROM credit_history;
-- Must equal pre_snapshot values.
-- Drift? Type: ROLLBACK TO SAVEPOINT phase_2_credit_history;


-- ===========================================================================
-- PHASE 3 — merge user_credits where both shadow and real exist (case i).
-- ===========================================================================
SAVEPOINT phase_3_credits_merge;

-- 3a. Add shadow values into the real row.
WITH merge_pairs AS (
  SELECT m.shadow_id, m.real_id,
         shad.balance_fula         AS shad_bal,
         shad.total_deposited_fula AS shad_dep,
         shad.total_deducted_fula  AS shad_ded,
         shad.is_suspended         AS shad_sus,
         shad.suspended_at         AS shad_susat,
         shad.last_deduction_at    AS shad_last
  FROM uid_migration_map m
  JOIN user_credits shad ON shad.user_id = m.shadow_id
  WHERE EXISTS (SELECT 1 FROM user_credits real WHERE real.user_id = m.real_id)
)
UPDATE user_credits real
SET balance_fula         = real.balance_fula         + mp.shad_bal,
    total_deposited_fula = real.total_deposited_fula + mp.shad_dep,
    total_deducted_fula  = real.total_deducted_fula  + mp.shad_ded,
    is_suspended         = GREATEST(real.is_suspended, mp.shad_sus),
    suspended_at         = COALESCE(real.suspended_at, mp.shad_susat),
    last_deduction_at    = GREATEST(
                              COALESCE(real.last_deduction_at, 'epoch'::timestamptz),
                              COALESCE(mp.shad_last,           'epoch'::timestamptz)
                           ),
    updated_at = NOW()
FROM merge_pairs mp
WHERE real.user_id = mp.real_id;

-- 3b. Delete the shadow rows that were merged.
WITH deleted AS (
  DELETE FROM user_credits
  WHERE user_id IN (
    SELECT m.shadow_id FROM uid_migration_map m
    WHERE EXISTS (SELECT 1 FROM user_credits ucr WHERE ucr.user_id = m.real_id)
  )
  RETURNING 1
)
SELECT 'phase_3_shadow_rows_deleted' AS metric, COUNT(*) AS v FROM deleted;

-- INVARIANT: financial totals must be unchanged across this phase
-- (we only redistributed shadow → real, no money created/destroyed).
SELECT 'user_credits_balance_sum_after_p3'   AS metric, COALESCE(SUM(balance_fula), 0)         AS v FROM user_credits
UNION ALL SELECT 'user_credits_deposited_sum_after_p3', COALESCE(SUM(total_deposited_fula), 0) FROM user_credits
UNION ALL SELECT 'user_credits_deducted_sum_after_p3',  COALESCE(SUM(total_deducted_fula), 0)  FROM user_credits;
-- Compare to pre_snapshot. Identical? Continue.
-- Drift even by 0.000001? Type: ROLLBACK TO SAVEPOINT phase_3_credits_merge;


-- ===========================================================================
-- PHASE 4 — promote orphan shadow rows where real row does not exist (case ii).
--
-- Assumption: the only mechanism that creates orphan shadow rows is the
-- deduction job's auto-create. Every suspension on such a row is bug-caused.
-- IMPORTANT: balance_fula left as-is to preserve the conservation invariant.
-- Operator reviews any orphan-with-negative-balance separately afterwards.
-- ===========================================================================
SAVEPOINT phase_4_orphan_promote;

WITH promoted AS (
  UPDATE user_credits uc
  SET user_id      = m.real_id,
      is_suspended = 0,
      suspended_at = NULL,
      -- balance_fula intentionally untouched (conservation)
      updated_at   = NOW()
  FROM uid_migration_map m
  WHERE uc.user_id = m.shadow_id
    AND NOT EXISTS (SELECT 1 FROM user_credits real WHERE real.user_id = m.real_id)
  RETURNING 1
)
SELECT 'phase_4_rows_promoted' AS metric, COUNT(*) AS v FROM promoted;

SELECT 'user_credits_at_shadow_after_p4' AS metric, COUNT(*) AS v
FROM user_credits uc JOIN uid_migration_map m ON uc.user_id = m.shadow_id;
-- Must be 0.


-- ===========================================================================
-- PHASE 5 — defensive sweeps on remaining user_id-bearing tables.
-- These should be no-ops in practice but guard against any future regression.
-- ===========================================================================
SAVEPOINT phase_5_other_tables;

WITH u AS (UPDATE api_keys           SET user_id = m.real_id FROM uid_migration_map m WHERE api_keys.user_id           = m.shadow_id RETURNING 1) SELECT 'phase_5_api_keys_updated'           AS metric, COUNT(*) AS v FROM u;
WITH u AS (UPDATE referral_codes     SET user_id = m.real_id FROM uid_migration_map m WHERE referral_codes.user_id     = m.shadow_id RETURNING 1) SELECT 'phase_5_referral_codes_updated'     AS metric, COUNT(*) AS v FROM u;
WITH u AS (UPDATE token_transactions SET user_id = m.real_id FROM uid_migration_map m WHERE token_transactions.user_id = m.shadow_id RETURNING 1) SELECT 'phase_5_token_transactions_updated' AS metric, COUNT(*) AS v FROM u;
WITH u AS (UPDATE user_wallets       SET user_id = m.real_id FROM uid_migration_map m WHERE user_wallets.user_id       = m.shadow_id RETURNING 1) SELECT 'phase_5_user_wallets_updated'       AS metric, COUNT(*) AS v FROM u;
WITH u AS (UPDATE webui_users        SET user_id = m.real_id FROM uid_migration_map m WHERE webui_users.user_id        = m.shadow_id RETURNING 1) SELECT 'phase_5_webui_users_updated'        AS metric, COUNT(*) AS v FROM u;
WITH u AS (UPDATE logins             SET user_id = m.real_id FROM uid_migration_map m WHERE logins.user_id             = m.shadow_id RETURNING 1) SELECT 'phase_5_logins_updated'             AS metric, COUNT(*) AS v FROM u;
WITH u AS (UPDATE ai_generations     SET user_id = m.real_id FROM uid_migration_map m WHERE ai_generations.user_id     = m.shadow_id RETURNING 1) SELECT 'phase_5_ai_generations_updated'     AS metric, COUNT(*) AS v FROM u;
-- sessions and users intentionally not touched — both should already be real-keyed.


-- ===========================================================================
-- FINAL VERIFICATION inside the transaction, BEFORE COMMIT.
-- Operator must check ALL of these against pre_snapshot:
--   final_pins_at_shadow            = 0
--   final_user_credits_at_shadow    = 0
--   final_pins_total                = pre_snapshot.pins_total
--   final_pins_total_size           = pre_snapshot.pins_total_size
--   final_credit_history_rows       = pre_snapshot.credit_history_rows
--   final_credit_history_sum        = pre_snapshot.credit_history_amount_sum
--   final_credits_balance_sum       = pre_snapshot.user_credits_balance_sum
--   final_credits_deposited_sum     = pre_snapshot.user_credits_deposited_sum
--   final_credits_deducted_sum      = pre_snapshot.user_credits_deducted_sum
-- ===========================================================================
SELECT          'final_pins_at_shadow'         AS check, COUNT(*) AS n FROM pins p JOIN uid_migration_map m ON p.user_id = m.shadow_id
UNION ALL SELECT 'final_user_credits_at_shadow',         COUNT(*)        FROM user_credits uc JOIN uid_migration_map m ON uc.user_id = m.shadow_id
UNION ALL SELECT 'final_pins_total',                     COUNT(*)        FROM pins
UNION ALL SELECT 'final_pins_total_size',                COALESCE(SUM(size), 0) FROM pins
UNION ALL SELECT 'final_credit_history_rows',            COUNT(*)        FROM credit_history
UNION ALL SELECT 'final_credit_history_sum',             COALESCE(SUM(amount_fula), 0) FROM credit_history
UNION ALL SELECT 'final_credits_balance_sum',            COALESCE(SUM(balance_fula), 0) FROM user_credits
UNION ALL SELECT 'final_credits_deposited_sum',          COALESCE(SUM(total_deposited_fula), 0) FROM user_credits
UNION ALL SELECT 'final_credits_deducted_sum',           COALESCE(SUM(total_deducted_fula), 0) FROM user_credits;

-- Side-by-side reference query — easier than eyeballing two lists:
SELECT pre.metric, pre.v AS pre_value,
       post.v AS post_value,
       (post.v - pre.v) AS delta
FROM pre_snapshot pre
LEFT JOIN (
            SELECT 'pins_total'                  AS metric, COUNT(*)::numeric AS v FROM pins
  UNION ALL SELECT 'pins_total_size',                COALESCE(SUM(size), 0)        FROM pins
  UNION ALL SELECT 'user_credits_rows',              COUNT(*)                      FROM user_credits
  UNION ALL SELECT 'user_credits_balance_sum',       COALESCE(SUM(balance_fula), 0)         FROM user_credits
  UNION ALL SELECT 'user_credits_deposited_sum',     COALESCE(SUM(total_deposited_fula), 0) FROM user_credits
  UNION ALL SELECT 'user_credits_deducted_sum',      COALESCE(SUM(total_deducted_fula), 0)  FROM user_credits
  UNION ALL SELECT 'credit_history_rows',            COUNT(*)                      FROM credit_history
  UNION ALL SELECT 'credit_history_amount_sum',      COALESCE(SUM(amount_fula), 0) FROM credit_history
  UNION ALL SELECT 'pins_at_shadow_count',
         COUNT(*)::numeric FROM pins p JOIN uid_migration_map m ON p.user_id = m.shadow_id
  UNION ALL SELECT 'user_credits_at_shadow_count',
         COUNT(*)::numeric FROM user_credits uc JOIN uid_migration_map m ON uc.user_id = m.shadow_id
) post USING (metric)
ORDER BY pre.metric;


-- ===========================================================================
-- AT THE psql PROMPT, type ONE of the following manually (NOT both):
--
--   COMMIT;     -- only if every check above passes
--   ROLLBACK;   -- if any check fails or anything looks off
--
-- The two commands are intentionally NOT in this file. Type one.
-- ===========================================================================
