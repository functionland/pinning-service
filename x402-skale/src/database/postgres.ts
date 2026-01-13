/**
 * PostgreSQL Database Module for x402-skale Gateway
 *
 * This module provides PostgreSQL connectivity for the x402 payment gateway.
 */

import pg from 'pg';
const { Pool } = pg;

// Pool instance
let pool: pg.Pool | null = null;

// Get configuration from environment
export function getPostgresConfig() {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'pinning_service',
    user: process.env.POSTGRES_USER || 'pinning_user',
    password: process.env.POSTGRES_PASSWORD || '',
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 25,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

// Create and configure the connection pool
export function createPostgresPool(): pg.Pool {
  if (pool) {
    return pool;
  }

  const config = getPostgresConfig();
  pool = new Pool(config);

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });

  pool.on('connect', () => {
    console.log('PostgreSQL client connected');
  });

  return pool;
}

// Get the pool instance
export function getPool(): pg.Pool {
  if (!pool) {
    return createPostgresPool();
  }
  return pool;
}

// Execute a query
export async function query<T = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params);
}

// Get a client from the pool (for transactions)
export async function getClient(): Promise<pg.PoolClient> {
  const p = getPool();
  return p.connect();
}

// Close the pool
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Check if PostgreSQL is configured
export function isPostgresConfigured(): boolean {
  return !!process.env.POSTGRES_HOST;
}

// Verify database connection
export async function verifyConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT 1 as connected');
    return result.rows[0]?.connected === 1;
  } catch (error) {
    console.error('PostgreSQL connection verification failed:', error);
    return false;
  }
}

// x402 specific operations

// Create payment log
export async function createPaymentLog(paymentId: string, wallet: string, amountRaw: string, amountUsdc: number, network: string, bucket?: string, objectKey?: string, sizeBytes?: number, sizeMb?: number, ttlSeconds?: number) {
  const result = await query(
    `INSERT INTO x402_payment_logs (payment_id, wallet, amount_raw, amount_usdc, network, bucket, object_key, size_bytes, size_mb, ttl_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [paymentId, wallet.toLowerCase(), amountRaw, amountUsdc, network, bucket, objectKey, sizeBytes, sizeMb, ttlSeconds]
  );
  return result.rows[0]?.id;
}

// Mark payment verified
export async function markPaymentVerified(paymentId: string, txHash: string) {
  await query(
    `UPDATE x402_payment_logs SET status = 'verified', tx_hash = $1, verified_at = NOW() WHERE payment_id = $2`,
    [txHash, paymentId]
  );
}

// Mark payment settled
export async function markPaymentSettled(paymentId: string) {
  await query(
    `UPDATE x402_payment_logs SET status = 'settled', settled_at = NOW() WHERE payment_id = $1`,
    [paymentId]
  );
}

// Mark payment failed
export async function markPaymentFailed(paymentId: string, errorMessage: string) {
  await query(
    `UPDATE x402_payment_logs SET status = 'failed', error_message = $1 WHERE payment_id = $2`,
    [errorMessage, paymentId]
  );
}

// Track ephemeral object
export async function trackEphemeralObject(bucket: string, objectKey: string, wallet: string, sizeBytes: number, sizeMb: number, paymentId: string, expiresAt: Date) {
  await query(
    `INSERT INTO x402_ephemeral_objects (bucket, object_key, wallet, size_bytes, size_mb, payment_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (bucket, object_key) DO UPDATE SET
       wallet = EXCLUDED.wallet,
       size_bytes = EXCLUDED.size_bytes,
       size_mb = EXCLUDED.size_mb,
       payment_id = EXCLUDED.payment_id,
       expires_at = EXCLUDED.expires_at,
       deleted = 0,
       deleted_at = NULL,
       delete_error = NULL`,
    [bucket, objectKey, wallet.toLowerCase(), sizeBytes, sizeMb, paymentId, expiresAt]
  );
}

// Get expired objects
export async function getExpiredObjects(limit: number = 100) {
  const result = await query(
    `SELECT id, bucket, object_key, wallet, size_bytes, payment_id, expires_at
     FROM x402_ephemeral_objects
     WHERE deleted = 0 AND expires_at < NOW()
     ORDER BY expires_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Mark object deleted
export async function markObjectDeleted(bucket: string, objectKey: string, error?: string) {
  await query(
    `UPDATE x402_ephemeral_objects SET deleted = 1, deleted_at = NOW(), delete_error = $1
     WHERE bucket = $2 AND object_key = $3`,
    [error || null, bucket, objectKey]
  );
}

// Get payment log
export async function getPaymentLog(paymentId: string) {
  const result = await query(
    `SELECT * FROM x402_payment_logs WHERE payment_id = $1`,
    [paymentId]
  );
  return result.rows[0];
}

// Get payment logs by wallet
export async function getPaymentLogsByWallet(wallet: string, limit: number = 50) {
  const result = await query(
    `SELECT * FROM x402_payment_logs WHERE wallet = $1 ORDER BY created_at DESC LIMIT $2`,
    [wallet.toLowerCase(), limit]
  );
  return result.rows;
}

export default {
  createPostgresPool,
  getPool,
  query,
  getClient,
  closePool,
  isPostgresConfigured,
  verifyConnection,
  createPaymentLog,
  markPaymentVerified,
  markPaymentSettled,
  markPaymentFailed,
  trackEphemeralObject,
  getExpiredObjects,
  markObjectDeleted,
  getPaymentLog,
  getPaymentLogsByWallet,
};
