-- PostgreSQL Schema for Pinning Service
-- Migrated from SQLite - All table and column names preserved
--
-- Run with: psql -d pinning_service -f 001_initial_schema.sql

-- ============================================
-- Core Tables (Main Go Service)
-- ============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pool_id INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    session_token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ,
    CONSTRAINT fk_sessions_username FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Pins table
CREATE TABLE IF NOT EXISTS pins (
    id SERIAL PRIMARY KEY,
    requestid TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    cid TEXT NOT NULL,
    name TEXT DEFAULT '',
    name_lowercase TEXT DEFAULT '',
    origins TEXT DEFAULT '[]',
    meta TEXT DEFAULT '{}',
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'pinning', 'pinned', 'failed', 'deleted')),
    upload_status TEXT DEFAULT 'pending',
    remove_status TEXT DEFAULT NULL,
    delegates TEXT DEFAULT '[]',
    info TEXT DEFAULT '{}',
    size BIGINT DEFAULT 0,
    session_token TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_pins_username FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Logins audit table
CREATE TABLE IF NOT EXISTS logins (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    status TEXT DEFAULT 'success' CHECK(status IN ('success', 'failed', 'locked')),
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- WebUI Tables (pinning-webui)
-- ============================================

-- WebUI Users table (must be created before api_keys due to FK)
CREATE TABLE IF NOT EXISTS webui_users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    picture TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ,
    total_upload_size BIGINT DEFAULT 0,
    app_downloaded INTEGER DEFAULT 0,
    app_downloaded_at TIMESTAMPTZ
);

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    key_id TEXT NOT NULL UNIQUE,
    user_email TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ,
    is_deleted INTEGER DEFAULT 0,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT fk_api_keys_user_email FOREIGN KEY (user_email) REFERENCES webui_users(email)
);

-- User wallets (linked blockchain addresses)
CREATE TABLE IF NOT EXISTS user_wallets (
    id SERIAL PRIMARY KEY,
    user_email TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    is_verified INTEGER DEFAULT 0,
    connected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_email, wallet_address, chain_id)
);

-- Token transactions (FULA payments to vault)
CREATE TABLE IF NOT EXISTS token_transactions (
    id SERIAL PRIMARY KEY,
    tx_hash TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount_raw TEXT NOT NULL,
    amount_fula REAL NOT NULL,
    block_number BIGINT NOT NULL,
    block_timestamp BIGINT NOT NULL,
    user_email TEXT,
    claimed_at TIMESTAMPTZ,
    ingestion_source TEXT CHECK(ingestion_source IN ('cron', 'manual')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tx_hash, chain_id)
);

-- Chain sync state (for block scanner cron)
CREATE TABLE IF NOT EXISTS chain_sync_state (
    chain_id INTEGER PRIMARY KEY,
    chain_name TEXT NOT NULL,
    last_scanned_block BIGINT DEFAULT 0,
    last_scan_at TIMESTAMPTZ,
    is_enabled INTEGER DEFAULT 1,
    token_address TEXT NOT NULL,
    vault_address TEXT NOT NULL
);

-- User credits (FULA balance for storage)
CREATE TABLE IF NOT EXISTS user_credits (
    id SERIAL PRIMARY KEY,
    user_email TEXT NOT NULL UNIQUE,
    balance_fula REAL DEFAULT 0,
    total_deposited_fula REAL DEFAULT 0,
    total_deducted_fula REAL DEFAULT 0,
    last_deduction_at TIMESTAMPTZ,
    is_suspended INTEGER DEFAULT 0,
    suspended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Credit history (audit log)
CREATE TABLE IF NOT EXISTS credit_history (
    id SERIAL PRIMARY KEY,
    user_email TEXT NOT NULL,
    tx_type TEXT CHECK(tx_type IN ('deposit', 'hourly_deduction', 'adjustment')),
    amount_fula REAL NOT NULL,
    balance_after REAL NOT NULL,
    reference_id TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Referral codes table
CREATE TABLE IF NOT EXISTS referral_codes (
    id SERIAL PRIMARY KEY,
    user_email TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_referral_codes_user_email FOREIGN KEY (user_email) REFERENCES webui_users(email)
);

-- Referrals tracking table
CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_email TEXT NOT NULL,
    referred_email TEXT NOT NULL UNIQUE,
    referral_code TEXT NOT NULL,
    referred_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_referrals_referrer_email FOREIGN KEY (referrer_email) REFERENCES webui_users(email),
    CONSTRAINT fk_referrals_referred_email FOREIGN KEY (referred_email) REFERENCES webui_users(email),
    CONSTRAINT fk_referrals_referral_code FOREIGN KEY (referral_code) REFERENCES referral_codes(code)
);

-- ============================================
-- x402-skale Tables (Payment Gateway)
-- ============================================

-- x402 Payment Logs (Append-Only Audit Trail)
CREATE TABLE IF NOT EXISTS x402_payment_logs (
    id SERIAL PRIMARY KEY,
    payment_id TEXT NOT NULL UNIQUE,
    wallet TEXT NOT NULL,
    tx_hash TEXT,
    amount_raw TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    network TEXT NOT NULL,
    bucket TEXT,
    object_key TEXT,
    size_bytes BIGINT,
    size_mb REAL,
    ttl_seconds INTEGER,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'settled', 'failed')),
    verified_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Ephemeral Objects (TTL Tracking for Cleanup)
CREATE TABLE IF NOT EXISTS x402_ephemeral_objects (
    id SERIAL PRIMARY KEY,
    bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,
    wallet TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    size_mb REAL NOT NULL,
    payment_id TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    deleted INTEGER DEFAULT 0,
    deleted_at TIMESTAMPTZ,
    delete_error TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bucket, object_key),
    CONSTRAINT fk_ephemeral_payment_id FOREIGN KEY (payment_id) REFERENCES x402_payment_logs(payment_id)
);

-- Gateway Statistics (Daily Metrics)
CREATE TABLE IF NOT EXISTS x402_gateway_stats (
    id SERIAL PRIMARY KEY,
    stat_date DATE NOT NULL UNIQUE,
    total_requests INTEGER DEFAULT 0,
    total_payments INTEGER DEFAULT 0,
    total_settled INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    total_bytes_uploaded BIGINT DEFAULT 0,
    total_usdc_received REAL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
