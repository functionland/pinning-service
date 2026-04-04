-- Migration 009: Add hashed session token columns for PII remediation
--
-- Adds token_hash (SHA-256) columns alongside existing plain-text session_token columns.
-- Code will dual-write both columns but read only from token_hash.
-- Plain-text columns are kept intact until manual cleanup via wipe-plaintext-pii.sh.

-- Sessions table: add token_hash
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);

-- Backfill token_hash from existing session_token values
UPDATE sessions
SET token_hash = encode(sha256(session_token::bytea), 'hex')
WHERE token_hash IS NULL AND session_token IS NOT NULL AND session_token != '';

-- Unique index on token_hash (used for lookups)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

-- Pins table: add token_hash for the session_token reference
ALTER TABLE pins ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);

-- Backfill pins.token_hash
UPDATE pins
SET token_hash = encode(sha256(session_token::bytea), 'hex')
WHERE token_hash IS NULL AND session_token IS NOT NULL AND session_token != '';

-- Index on pins.token_hash (used for per-key queries)
CREATE INDEX IF NOT EXISTS idx_pins_token_hash ON pins(token_hash);
