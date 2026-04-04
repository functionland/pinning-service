-- Migration 013: Add key_hash column for hash-based API key lookup
-- Replaces plain-text key_id matching with SHA-256 hash lookup.
-- New records store key_hash + encrypted_key only (key_id = NULL).

-- Add key_hash column for hash-based lookup
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64);

-- Backfill from existing plain-text key_id
UPDATE api_keys SET key_hash = encode(sha256(key_id::bytea), 'hex')
  WHERE key_hash IS NULL AND key_id IS NOT NULL;

-- Index for fast lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);

-- Allow NULL in key_id for new records (was NOT NULL UNIQUE from 001_initial_schema)
ALTER TABLE api_keys ALTER COLUMN key_id DROP NOT NULL;
