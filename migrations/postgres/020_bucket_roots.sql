-- Migration 020: shared bucket-root pointers (FM-1, Phase 2.5)
--
-- With more than one federated master serving S3 writes, each bucket's root
-- CID needs an arbiter every master can compare-and-swap; the gateways'
-- in-process locks cannot see each other. The fula-gateway (flag
-- FULA_BUCKET_ROOT_CAS, fula-api crates/fula-cli/src/root_store_pg.rs)
-- performs a single-statement upsert-CAS against this table:
--
--   INSERT .. ON CONFLICT (owner_id, bucket) DO UPDATE
--     SET root_cid = $new, version = version + 1
--     WHERE bucket_roots.root_cid = $expected
--
-- Purely additive: nothing reads or writes this table until the gateway
-- flag is enabled; flag-off masters are unaffected.
--
-- Revert: migrations/postgres/020_bucket_roots.down.sql

BEGIN;

CREATE TABLE IF NOT EXISTS bucket_roots (
    owner_id   TEXT NOT NULL,
    bucket     TEXT NOT NULL,
    root_cid   TEXT NOT NULL,
    version    BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, bucket)
);

COMMIT;
