-- Migration 018: Idempotency key for hourly deductions (FM-2, federated masters)
--
-- Two masters running the hourly deduction cron must never double-deduct.
-- New-style rows use a deterministic reference_id = 'hour:YYYY-MM-DDTHH' (UTC
-- hour bucket) and the cron INSERTs the credit_history row as its dedup GATE
-- (ON CONFLICT DO NOTHING) before touching user_credits — see
-- pinning-webui/server/services/deductionJob.ts (flag BILLING_IDEMPOTENCY).
--
-- This partial UNIQUE index is the arbiter. It only covers hourly_deduction
-- rows: deposits/adjustments/referral bonuses keep their existing semantics
-- (deposit dedup is the token_transactions (tx_hash, chain_id) UNIQUE).
--
-- Existing rows are unaffected: legacy reference_id values are RFC3339
-- timestamps with millisecond precision, distinct per (user_id) in practice.
-- A pre-check below aborts with an actionable message if that assumption is
-- ever violated, BEFORE attempting the index build.
--
-- CONCURRENTLY (cannot run inside a transaction): credit_history grows by one
-- row per billable user per hour, so it may be large in production; a
-- non-concurrent build would hold ACCESS EXCLUSIVE and block billing inserts.
-- If a concurrent build is interrupted it leaves an INVALID index; recover
-- with:  DROP INDEX CONCURRENTLY IF EXISTS idx_credit_history_hourly_dedup;
-- then re-run this migration.
--
-- Revert: migrations/postgres/018_deduction_idempotency.down.sql

-- Safety pre-check (autocommit; aborts the psql run via ON_ERROR_STOP).
DO $$
DECLARE
    dup_count integer;
BEGIN
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT user_id, reference_id
        FROM credit_history
        WHERE tx_type = 'hourly_deduction' AND user_id IS NOT NULL
        GROUP BY user_id, reference_id
        HAVING COUNT(*) > 1
    ) t;

    IF dup_count > 0 THEN
        RAISE EXCEPTION
            'Migration 018 aborted: % duplicate (user_id, reference_id) pair(s) in '
            'credit_history for tx_type=hourly_deduction. Inspect with: '
            'SELECT user_id, reference_id, COUNT(*) FROM credit_history '
            'WHERE tx_type = ''hourly_deduction'' GROUP BY 1,2 HAVING COUNT(*) > 1;',
            dup_count;
    END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_history_hourly_dedup
    ON credit_history (user_id, reference_id)
    WHERE tx_type = 'hourly_deduction';
