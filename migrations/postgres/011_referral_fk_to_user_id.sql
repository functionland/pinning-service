-- Migration 011: Migrate FK constraints from email-based to user_id-based
--
-- Before PII wipe, FK constraints referencing webui_users(email) must be
-- changed to reference webui_users(user_id). This migration:
--   1. Adds UNIQUE constraint on webui_users(user_id) (needed as FK target)
--   2. Drops old email-based FK constraints
--   3. Adds new user_id-based FK constraints
--
-- Prerequisite: Migration 010 (user_id columns exist and are backfilled)
-- Plain-text email columns are NOT dropped.

-- ============================================
-- Step 1: UNIQUE constraint on webui_users(user_id)
-- Required for it to serve as FK target
-- ============================================

-- First, ensure no NULL user_id values exist in webui_users
-- (The ZK migration in app.ts should have backfilled these)
UPDATE webui_users
  SET user_id = encode(sha256(email::bytea), 'hex')
  WHERE user_id IS NULL AND email IS NOT NULL;

-- Backfill user_id in referral-related tables too
UPDATE referral_codes
  SET user_id = encode(sha256(user_email::bytea), 'hex')
  WHERE user_id IS NULL AND user_email IS NOT NULL;

UPDATE referrals
  SET referrer_id = encode(sha256(referrer_email::bytea), 'hex')
  WHERE referrer_id IS NULL AND referrer_email IS NOT NULL;

UPDATE referrals
  SET referred_id = encode(sha256(referred_email::bytea), 'hex')
  WHERE referred_id IS NULL AND referred_email IS NOT NULL;

UPDATE api_keys
  SET user_id = encode(sha256(user_email::bytea), 'hex')
  WHERE user_id IS NULL AND user_email IS NOT NULL;

-- Add UNIQUE constraint (idempotent via IF NOT EXISTS on index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_webui_users_user_id_unique
  ON webui_users(user_id);

-- ============================================
-- Step 2: Drop old email-based FK constraints
-- ============================================

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS fk_api_keys_user_email;
ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS fk_referral_codes_user_email;
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS fk_referrals_referrer_email;
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS fk_referrals_referred_email;

-- ============================================
-- Step 3: Add new user_id-based FK constraints
-- ============================================

-- api_keys(user_id) -> webui_users(user_id)
-- NOT VALID: skip checking existing rows (they may have orphaned user_ids from
-- users created by the Go pinning service that don't exist in webui_users).
-- Only new inserts/updates are validated. Run VALIDATE CONSTRAINT after verifying data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_api_keys_user_id'
      AND table_name = 'api_keys'
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT fk_api_keys_user_id
      FOREIGN KEY (user_id) REFERENCES webui_users(user_id) NOT VALID;
  END IF;
END $$;

-- referral_codes(user_id) -> webui_users(user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_referral_codes_user_id'
      AND table_name = 'referral_codes'
  ) THEN
    ALTER TABLE referral_codes
      ADD CONSTRAINT fk_referral_codes_user_id
      FOREIGN KEY (user_id) REFERENCES webui_users(user_id) NOT VALID;
  END IF;
END $$;

-- referrals(referrer_id) -> webui_users(user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_referrals_referrer_id'
      AND table_name = 'referrals'
  ) THEN
    ALTER TABLE referrals
      ADD CONSTRAINT fk_referrals_referrer_id
      FOREIGN KEY (referrer_id) REFERENCES webui_users(user_id) NOT VALID;
  END IF;
END $$;

-- referrals(referred_id) -> webui_users(user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_referrals_referred_id'
      AND table_name = 'referrals'
  ) THEN
    ALTER TABLE referrals
      ADD CONSTRAINT fk_referrals_referred_id
      FOREIGN KEY (referred_id) REFERENCES webui_users(user_id) NOT VALID;
  END IF;
END $$;

-- Keep the existing FK on referral_code -> referral_codes(code) — that's fine
-- CONSTRAINT fk_referrals_referral_code is not email-based, no change needed
