-- Migration 016: blocked_cids — add `mode` column for per-CID action policy
--
-- mode='block'    → gateway returns HTTP 451 (existing behavior, default)
-- mode='redirect' → gateway returns HTTP 301 to https://ipfs.io/ipfs/{cid}
--
-- The table name stays `blocked_cids` even though it now stores both block
-- and redirect rows; renaming the table is out of scope.
--
-- Safety: idempotent (ADD COLUMN IF NOT EXISTS). PG >= 11 makes a NOT NULL
-- column with a constant default a metadata-only change (no row rewrite).
-- Revert: migrations/postgres/016_blocked_cids_mode.down.sql

BEGIN;

ALTER TABLE blocked_cids
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'block'
    CHECK (mode IN ('block', 'redirect'));

COMMIT;
