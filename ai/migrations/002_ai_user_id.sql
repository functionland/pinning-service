-- Migration 002: Add user_id column (SHA-256 hash of email) to ai_generations
-- New records store user_id (hash) instead of plain-text user_email.
-- All statements are idempotent for safe re-runs on every service startup.

ALTER TABLE ai_generations ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);

UPDATE ai_generations SET user_id = encode(sha256(lower(user_email)::bytea), 'hex')
  WHERE user_id IS NULL AND user_email IS NOT NULL AND user_email LIKE '%@%';

CREATE INDEX IF NOT EXISTS idx_ai_generations_user_id ON ai_generations(user_id);

ALTER TABLE ai_generations ALTER COLUMN user_email DROP NOT NULL;
