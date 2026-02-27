-- Migration 006: Add encrypted_key column to api_keys for at-rest encryption
-- Backward-compatible: key_id remains for lookup/verification,
-- encrypted_key stores the AES-256-GCM encrypted version

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS encrypted_key TEXT;

-- Index on encrypted_key is not needed since we still look up by key_id
