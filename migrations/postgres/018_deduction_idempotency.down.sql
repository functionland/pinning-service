-- Revert migration 018: drop the hourly-deduction idempotency index.
-- Safe: the index is purely additive; dropping it restores pre-018 behavior
-- (set BILLING_IDEMPOTENCY=false on all masters FIRST so the cron stops
-- relying on ON CONFLICT, otherwise inserts will fail with 42P10).
DROP INDEX CONCURRENTLY IF EXISTS idx_credit_history_hourly_dedup;
