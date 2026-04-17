-- Migration 014: Add UNIQUE constraint on user_credits.user_id
--
-- Fixes ON CONFLICT (user_id) failures in creditUser(), blockScanner, and
-- deductionJob. Migration 012 dropped user_credits_user_email_key, but no
-- UNIQUE replacement was created on user_id — only a non-unique index
-- (idx_user_credits_user_id). PostgreSQL error 42P10 results:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- This migration mirrors the pattern used for webui_users in migration 011
-- (idx_webui_users_user_id_unique): a non-partial UNIQUE index on user_id.
-- NULLs are allowed (Postgres default NULLS DISTINCT) so legacy rows with
-- NULL user_id remain valid.
--
-- Safety:
--   1. Runs in a single transaction (BEGIN/COMMIT) — rolls back on any error.
--   2. Pre-checks for duplicate non-NULL user_id rows and aborts with a clear
--      message if any exist. No rows are modified or deleted.
--   3. Idempotent via CREATE UNIQUE INDEX IF NOT EXISTS — safe to re-run.
--   4. Uses non-CONCURRENT index creation so it fits inside the transaction;
--      user_credits is small, so the brief ACCESS EXCLUSIVE lock is acceptable.
--
-- Revert: migrations/postgres/014_user_credits_unique_user_id.down.sql

BEGIN;

-- Safety check: abort if duplicate user_ids exist. The UNIQUE index would fail
-- to build anyway, but this gives a clear, actionable error instead.
DO $$
DECLARE
    dup_count integer;
BEGIN
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT user_id
        FROM user_credits
        WHERE user_id IS NOT NULL
        GROUP BY user_id
        HAVING COUNT(*) > 1
    ) t;

    IF dup_count > 0 THEN
        RAISE EXCEPTION
            'Migration 014 aborted: % duplicate user_id value(s) found in user_credits. '
            'Resolve duplicates manually before retrying. Inspect with: '
            'SELECT user_id, COUNT(*) FROM user_credits WHERE user_id IS NOT NULL '
            'GROUP BY user_id HAVING COUNT(*) > 1;',
            dup_count;
    END IF;
END $$;

-- Create non-partial UNIQUE index on user_id. Matches the precedent set by
-- idx_webui_users_user_id_unique (migration 011). ON CONFLICT (user_id)
-- without a WHERE predicate will correctly infer this as the arbiter index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_credits_user_id_unique
    ON user_credits(user_id);

COMMIT;
