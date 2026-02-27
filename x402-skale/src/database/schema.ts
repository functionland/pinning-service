/**
 * Database Schema for x402-skale Gateway (PostgreSQL)
 *
 * Only tracking tables needed - no user credentials stored.
 * Users authenticate via JWT passed through to S3 backend.
 */

export const schema = `
-- ============================================
-- x402 Payment Logs (Append-Only Audit Trail)
-- ============================================
CREATE TABLE IF NOT EXISTS x402_payment_logs (
  id SERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE,          -- x402 payment identifier
  wallet TEXT NOT NULL,                     -- Payer wallet address (lowercase)
  tx_hash TEXT,                             -- Blockchain transaction hash
  amount_raw TEXT NOT NULL,                 -- Raw amount (microUSDC)
  amount_usdc NUMERIC NOT NULL,             -- Amount in USDC (human readable)
  network TEXT NOT NULL,                    -- Chain identifier (e.g., "eip155:324705682")
  bucket TEXT,                              -- Target S3 bucket
  object_key TEXT,                          -- Target S3 object key
  size_bytes BIGINT,                        -- Object size in bytes
  size_mb NUMERIC,                          -- Object size in MB
  ttl_seconds INTEGER,                      -- TTL for ephemeral storage
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'settled', 'failed')),
  verified_at TIMESTAMP,
  settled_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_wallet ON x402_payment_logs(wallet);
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_tx_hash ON x402_payment_logs(tx_hash);
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_status ON x402_payment_logs(status);
CREATE INDEX IF NOT EXISTS idx_x402_payment_logs_created ON x402_payment_logs(created_at DESC);

-- ============================================
-- Ephemeral Objects (TTL Tracking for Cleanup)
-- ============================================
CREATE TABLE IF NOT EXISTS x402_ephemeral_objects (
  id SERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,                     -- S3 bucket name
  object_key TEXT NOT NULL,                 -- S3 object key
  wallet TEXT NOT NULL,                     -- Owner wallet address
  size_bytes BIGINT NOT NULL,               -- Object size in bytes
  size_mb NUMERIC NOT NULL,                 -- Object size in MB
  payment_id TEXT,                          -- Link to payment log
  expires_at TIMESTAMP NOT NULL,            -- When to delete
  deleted INTEGER DEFAULT 0,                -- Soft delete flag (0=active, 1=deleted)
  deleted_at TIMESTAMP,                     -- When deleted
  delete_attempts INTEGER DEFAULT 0,        -- Number of failed delete attempts
  delete_error TEXT,                        -- Error message if delete failed
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(bucket, object_key),
  FOREIGN KEY (payment_id) REFERENCES x402_payment_logs(payment_id)
);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_bucket_key ON x402_ephemeral_objects(bucket, object_key);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_wallet ON x402_ephemeral_objects(wallet);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_expires ON x402_ephemeral_objects(expires_at);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_deleted ON x402_ephemeral_objects(deleted);
CREATE INDEX IF NOT EXISTS idx_x402_ephemeral_payment ON x402_ephemeral_objects(payment_id);

-- ============================================
-- Gateway Statistics (Optional Metrics)
-- ============================================
CREATE TABLE IF NOT EXISTS x402_gateway_stats (
  id SERIAL PRIMARY KEY,
  stat_date DATE NOT NULL UNIQUE,           -- Date for daily stats
  total_requests INTEGER DEFAULT 0,
  total_payments INTEGER DEFAULT 0,
  total_settled INTEGER DEFAULT 0,
  total_failed INTEGER DEFAULT 0,
  total_bytes_uploaded BIGINT DEFAULT 0,
  total_usdc_received NUMERIC DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_x402_gateway_stats_date ON x402_gateway_stats(stat_date DESC);
`;

export default schema;
