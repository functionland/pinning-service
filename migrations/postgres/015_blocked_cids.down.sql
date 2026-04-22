-- Revert Migration 015: drop blocked_cids table
--
-- After this runs, gateway will no longer block any CID. Remove the filename
-- from .migration_state on the host so deploy.sh re-applies on next run:
--   sed -i '/^015_blocked_cids\.sql/d' /home/root/pinning-service/.migration_state

BEGIN;

DROP TABLE IF EXISTS blocked_cids;

COMMIT;
