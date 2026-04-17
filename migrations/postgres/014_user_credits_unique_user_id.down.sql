-- Revert Migration 014: Drop the UNIQUE index on user_credits.user_id
--
-- Removes idx_user_credits_user_id_unique. After this runs, code paths that
-- use ON CONFLICT (user_id) on user_credits will fail again with 42P10 —
-- only revert if rolling back the corresponding code change as well.
--
-- The non-unique index idx_user_credits_user_id (created by app.ts startup
-- migration) is left in place; it predates migration 014 and is still used
-- for lookups by user_id.

BEGIN;

DROP INDEX IF EXISTS idx_user_credits_user_id_unique;

-- Remove the state file entry so deploy.sh will re-apply on next run.
-- (This comment is informational — state file is outside the database.
--  To fully revert, also run on the host:
--    sed -i '/^014_user_credits_unique_user_id\.sql/d' \
--        /home/root/pinning-service/.migration_state)

COMMIT;
