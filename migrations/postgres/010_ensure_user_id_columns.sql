-- Migration 010: Ensure all tables have user_id columns and add encrypted_email
--
-- The ZK migration in app.ts already adds user_id columns at runtime,
-- but this migration ensures they exist at the schema level and adds
-- encrypted_email for OAuth login recovery.
-- Plain-text email columns are NOT dropped — they remain as a safety net.

-- ============================================
-- Ensure user_id columns exist on all tables
-- (idempotent — most already added by app.ts ZK migration)
-- ============================================

ALTER TABLE webui_users ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE pins ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_id VARCHAR(64);
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_id VARCHAR(64);
ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE credit_history ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS wallet_address_hash VARCHAR(64);
ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS encrypted_wallet_address TEXT;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS actor_id VARCHAR(64);
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_id VARCHAR(64);

-- logins table: add user_id (not covered by app.ts ZK migration)
ALTER TABLE logins ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);

-- ============================================
-- Encrypted email for OAuth login recovery
-- ============================================

ALTER TABLE webui_users ADD COLUMN IF NOT EXISTS encrypted_email TEXT;

-- ============================================
-- Indexes on user_id columns
-- (idempotent — some already added by app.ts)
-- ============================================

CREATE INDEX IF NOT EXISTS idx_webui_users_user_id ON webui_users(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_pins_user_id ON pins(user_id);
CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credits_user_id ON user_credits(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_history_user_id ON credit_history(user_id);
CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_user_wallets_hash ON user_wallets(wallet_address_hash);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_token_transactions_user_id ON token_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_logins_user_id ON logins(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor_id ON admin_audit_log(actor_id);

-- Unique constraint for wallet lookup by user_id + hash + chain
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_uid_hash_chain
  ON user_wallets(user_id, wallet_address_hash, chain_id);
