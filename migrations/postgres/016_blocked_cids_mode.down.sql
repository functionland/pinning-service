-- Revert Migration 016: drop `mode` column from blocked_cids
--
-- After this runs, all rows are treated as 'block' by the gateway (any
-- 'redirect' rows silently revert to block-only behavior on next cache load).
--
-- Remove the filename from .migration_state on the host so deploy.sh re-applies
-- on next run:
--   sed -i '/^016_blocked_cids_mode\.sql/d' /home/root/pinning-service/.migration_state

BEGIN;

ALTER TABLE blocked_cids DROP COLUMN IF EXISTS mode;

COMMIT;
