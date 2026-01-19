-- Migration: Multiple Referral Codes with Name/Tag Inheritance
-- Enables users to create multiple referral links with custom names
-- Names cascade through the referral chain
--
-- Run with: psql -d pinning_service -f 004_multiple_referral_codes.sql

-- Remove UNIQUE constraint on user_email to allow multiple codes per user
ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS referral_codes_user_email_key;

-- Add columns for name and inheritance tracking
ALTER TABLE referral_codes
    ADD COLUMN IF NOT EXISTS name TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS inherited_name TEXT DEFAULT NULL;

-- Mark all existing codes as defaults (preserves current behavior for existing users)
UPDATE referral_codes SET is_default = TRUE WHERE is_default IS NULL OR is_default = FALSE;

-- Add index for efficient lookups by user_email (replacing unique constraint)
CREATE INDEX IF NOT EXISTS idx_referral_codes_user_email ON referral_codes(user_email);

-- Add composite index for finding default code quickly
CREATE INDEX IF NOT EXISTS idx_referral_codes_user_email_default ON referral_codes(user_email, is_default) WHERE is_default = TRUE;
