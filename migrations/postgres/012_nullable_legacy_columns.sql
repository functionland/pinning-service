-- Migration 012: Drop NOT NULL / UNIQUE / FK constraints on legacy plain-text columns
--
-- After PII remediation, new entries no longer write plain-text email/username
-- to old columns. These constraints must be relaxed so new rows can have NULL
-- in legacy columns while old rows keep their values for testing.
--
-- Prerequisite: Migrations 009-011 (user_id, token_hash columns exist, FKs migrated)

-- ============================================
-- Step 1: Drop FK constraints that reference users(username)
-- Code now reads via user_id / token_hash instead
-- ============================================

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS fk_sessions_username;
ALTER TABLE pins DROP CONSTRAINT IF EXISTS fk_pins_username;

-- ============================================
-- Step 2: Drop UNIQUE constraints on legacy email columns
-- Replaced by user_id-based unique indexes
-- ============================================

-- users.username UNIQUE (needed by the FKs we just dropped)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;

-- webui_users.email UNIQUE (replaced by idx_webui_users_user_id_unique)
ALTER TABLE webui_users DROP CONSTRAINT IF EXISTS webui_users_email_key;

-- user_credits.user_email UNIQUE (now using user_id)
ALTER TABLE user_credits DROP CONSTRAINT IF EXISTS user_credits_user_email_key;

-- referrals.referred_email UNIQUE (now using referred_id)
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_referred_email_key;

-- user_wallets composite UNIQUE (user_email, wallet_address, chain_id)
-- Replaced by idx_user_wallets_uid_hash_chain
ALTER TABLE user_wallets DROP CONSTRAINT IF EXISTS user_wallets_user_email_wallet_address_chain_id_key;

-- ============================================
-- Step 3: Drop NOT NULL constraints on legacy columns
-- New entries will write NULL to these columns
-- ============================================

ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN username DROP NOT NULL;
ALTER TABLE webui_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE api_keys ALTER COLUMN user_email DROP NOT NULL;
ALTER TABLE user_credits ALTER COLUMN user_email DROP NOT NULL;
ALTER TABLE credit_history ALTER COLUMN user_email DROP NOT NULL;
ALTER TABLE referral_codes ALTER COLUMN user_email DROP NOT NULL;
ALTER TABLE referrals ALTER COLUMN referrer_email DROP NOT NULL;
ALTER TABLE referrals ALTER COLUMN referred_email DROP NOT NULL;
ALTER TABLE user_wallets ALTER COLUMN user_email DROP NOT NULL;
ALTER TABLE admin_audit_log ALTER COLUMN actor DROP NOT NULL;

-- logins.username — also used with plain-text email
ALTER TABLE logins ALTER COLUMN username DROP NOT NULL;

-- pins.username
ALTER TABLE pins ALTER COLUMN username DROP NOT NULL;
