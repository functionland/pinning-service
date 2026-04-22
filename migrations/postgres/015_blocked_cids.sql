-- Migration 015: blocked_cids — gateway content takedown list
--
-- Rows store normalized CIDv1-base32 strings. Gateway (ipfs-server) reads this
-- table to short-circuit requests for blocked content; pinning-webui admins
-- insert/delete rows via /api/admin/blocked-cids.
--
-- Safety: idempotent (CREATE TABLE/INDEX IF NOT EXISTS). Safe to re-run.
-- Revert: migrations/postgres/015_blocked_cids.down.sql

BEGIN;

CREATE TABLE IF NOT EXISTS blocked_cids (
    id           SERIAL PRIMARY KEY,
    cid          TEXT NOT NULL UNIQUE,
    reason       TEXT,
    blocked_by   VARCHAR(64),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UNIQUE on cid already creates a btree index; add created_at index for admin-list ordering
CREATE INDEX IF NOT EXISTS idx_blocked_cids_created_at ON blocked_cids(created_at DESC);

COMMIT;
