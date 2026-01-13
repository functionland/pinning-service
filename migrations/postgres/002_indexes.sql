-- PostgreSQL Indexes for Pinning Service
-- Run after 001_initial_schema.sql
--
-- Run with: psql -d pinning_service -f 002_indexes.sql

-- ============================================
-- Core Table Indexes
-- ============================================

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Sessions indexes
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Pins indexes (comprehensive for query performance)
CREATE INDEX IF NOT EXISTS idx_pins_requestid ON pins(requestid);
CREATE INDEX IF NOT EXISTS idx_pins_username ON pins(username);
CREATE INDEX IF NOT EXISTS idx_pins_cid ON pins(cid);
CREATE INDEX IF NOT EXISTS idx_pins_status ON pins(status);
CREATE INDEX IF NOT EXISTS idx_pins_name ON pins(name);
CREATE INDEX IF NOT EXISTS idx_pins_name_lower ON pins(name_lowercase);
CREATE INDEX IF NOT EXISTS idx_pins_created ON pins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pins_username_status ON pins(username, status);
CREATE INDEX IF NOT EXISTS idx_pins_username_created ON pins(username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pins_session_token ON pins(session_token);

-- Logins indexes
CREATE INDEX IF NOT EXISTS idx_logins_username ON logins(username);
CREATE INDEX IF NOT EXISTS idx_logins_created ON logins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logins_status ON logins(status);

-- ============================================
-- WebUI Table Indexes
-- ============================================

-- API Keys indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_user_email ON api_keys(user_email);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);

-- User wallets indexes
CREATE INDEX IF NOT EXISTS idx_user_wallets_email ON user_wallets(user_email);
CREATE INDEX IF NOT EXISTS idx_user_wallets_address ON user_wallets(wallet_address);

-- Token transactions indexes
CREATE INDEX IF NOT EXISTS idx_token_tx_from ON token_transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_token_tx_user ON token_transactions(user_email);
CREATE INDEX IF NOT EXISTS idx_token_tx_hash ON token_transactions(tx_hash);

-- User credits indexes
CREATE INDEX IF NOT EXISTS idx_user_credits_email ON user_credits(user_email);
CREATE INDEX IF NOT EXISTS idx_user_credits_suspended ON user_credits(is_suspended);

-- Credit history indexes
CREATE INDEX IF NOT EXISTS idx_credit_history_email ON credit_history(user_email);
CREATE INDEX IF NOT EXISTS idx_credit_history_type ON credit_history(tx_type);

-- Referral codes indexes
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_email ON referral_codes(user_email);

-- Referrals indexes
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_email);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_email);

-- ============================================
-- x402-skale Table Indexes
-- ============================================

-- x402 Payment Logs indexes
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_wallet ON x402_payment_logs(wallet);
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_tx_hash ON x402_payment_logs(tx_hash);
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_status ON x402_payment_logs(status);
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_created ON x402_payment_logs(created_at DESC);

-- x402 Ephemeral Objects indexes
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_bucket_key ON x402_ephemeral_objects(bucket, object_key);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_wallet ON x402_ephemeral_objects(wallet);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_expires ON x402_ephemeral_objects(expires_at);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_deleted ON x402_ephemeral_objects(deleted);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_payment ON x402_ephemeral_objects(payment_id);

-- x402 Gateway Stats indexes
CREATE INDEX IF NOT EXISTS idx_x402_gateway_stats_date ON x402_gateway_stats(stat_date DESC);
