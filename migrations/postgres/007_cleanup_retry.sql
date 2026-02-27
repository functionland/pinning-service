-- Migration 007: Add delete_attempts counter for cleanup retry logic
-- Objects that fail S3 deletion should be retried, not permanently marked deleted

ALTER TABLE x402_ephemeral_objects ADD COLUMN IF NOT EXISTS delete_attempts INTEGER DEFAULT 0;
-- delete_error column already exists from previous schema
