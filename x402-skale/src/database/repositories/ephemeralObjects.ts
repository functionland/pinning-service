/**
 * Ephemeral Objects Repository
 *
 * Manages temporary object tracking for TTL-based cleanup (PostgreSQL).
 */

import { query } from '../index.js';
import type { EphemeralObject } from '../../types/index.js';

/**
 * Track a new ephemeral object
 */
export async function trackEphemeralObject(params: {
  bucket: string;
  key: string;
  wallet: string;
  sizeBytes: number;
  sizeMb: number;
  paymentId?: string;
  expiresAt: Date;
}): Promise<void> {
  await query(
    `INSERT INTO x402_ephemeral_objects (
      bucket, object_key, wallet, size_bytes, size_mb, payment_id, expires_at, deleted
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
    ON CONFLICT (bucket, object_key) DO UPDATE SET
      wallet = EXCLUDED.wallet,
      size_bytes = EXCLUDED.size_bytes,
      size_mb = EXCLUDED.size_mb,
      payment_id = EXCLUDED.payment_id,
      expires_at = EXCLUDED.expires_at,
      deleted = 0,
      deleted_at = NULL,
      delete_error = NULL`,
    [
      params.bucket,
      params.key,
      params.wallet.toLowerCase(),
      params.sizeBytes,
      params.sizeMb,
      params.paymentId || null,
      params.expiresAt.toISOString(),
    ]
  );
}

/**
 * Get expired objects that need to be cleaned up
 */
export async function getExpiredObjects(limit = 100): Promise<EphemeralObject[]> {
  const result = await query<EphemeralObject>(
    `SELECT * FROM x402_ephemeral_objects
     WHERE expires_at < NOW()
       AND deleted = 0
     ORDER BY expires_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Get unpaid expired objects for aggressive cleanup
 * These are objects where payment was never settled (pending/failed or no payment log)
 * and they've been sitting around longer than the threshold
 */
export async function getUnpaidExpiredObjects(
  maxAgeMinutes: number = 30,
  limit: number = 100
): Promise<EphemeralObject[]> {
  const result = await query<EphemeralObject>(
    `SELECT e.*
     FROM x402_ephemeral_objects e
     LEFT JOIN x402_payment_logs p ON e.payment_id = p.payment_id
     WHERE e.deleted = 0
       AND e.created_at < NOW() - INTERVAL '1 minute' * $1
       AND (p.status IS NULL OR p.status IN ('pending', 'failed'))
     ORDER BY e.created_at ASC
     LIMIT $2`,
    [maxAgeMinutes, limit]
  );
  return result.rows;
}

/**
 * Mark an object as deleted
 */
export async function markObjectDeleted(id: number, error?: string): Promise<void> {
  await query(
    `UPDATE x402_ephemeral_objects
     SET deleted = 1, deleted_at = NOW(), delete_error = $1
     WHERE id = $2`,
    [error || null, id]
  );
}

/**
 * Mark all objects for a wallet as deleted
 * Called after user is deleted from S3 (cascading delete)
 */
export async function markAllUserObjectsDeleted(wallet: string): Promise<void> {
  const result = await query(
    `UPDATE x402_ephemeral_objects
     SET deleted = 1, deleted_at = NOW()
     WHERE wallet = $1 AND deleted = 0`,
    [wallet.toLowerCase()]
  );

  if (result.rowCount && result.rowCount > 0) {
    console.log(`[db] Marked ${result.rowCount} objects as deleted for wallet ${wallet}`);
  }
}

/**
 * Get ephemeral object by bucket and key
 */
export async function getEphemeralObject(bucket: string, key: string): Promise<EphemeralObject | undefined> {
  const result = await query<EphemeralObject>(
    `SELECT * FROM x402_ephemeral_objects
     WHERE bucket = $1 AND object_key = $2 AND deleted = 0`,
    [bucket, key]
  );
  return result.rows[0];
}

/**
 * Get all ephemeral objects for a wallet
 */
export async function getEphemeralObjectsByWallet(wallet: string, limit = 50): Promise<EphemeralObject[]> {
  const result = await query<EphemeralObject>(
    `SELECT * FROM x402_ephemeral_objects
     WHERE wallet = $1 AND deleted = 0
     ORDER BY created_at DESC
     LIMIT $2`,
    [wallet.toLowerCase(), limit]
  );
  return result.rows;
}

/**
 * Delete ephemeral object record (hard delete, for cleanup)
 */
export async function deleteEphemeralObjectRecord(id: number): Promise<void> {
  await query(
    `DELETE FROM x402_ephemeral_objects WHERE id = $1`,
    [id]
  );
}

/**
 * Get cleanup statistics
 */
export async function getCleanupStats(): Promise<{
  total_active: number;
  total_expired: number;
  total_deleted: number;
  total_bytes_active: number;
}> {
  const result = await query<{
    total_active: string;
    total_expired: string;
    total_deleted: string;
    total_bytes_active: string;
  }>(
    `SELECT
      SUM(CASE WHEN deleted = 0 AND expires_at >= NOW() THEN 1 ELSE 0 END) as total_active,
      SUM(CASE WHEN deleted = 0 AND expires_at < NOW() THEN 1 ELSE 0 END) as total_expired,
      SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) as total_deleted,
      COALESCE(SUM(CASE WHEN deleted = 0 AND expires_at >= NOW() THEN size_bytes ELSE 0 END), 0) as total_bytes_active
    FROM x402_ephemeral_objects`
  );

  const row = result.rows[0];
  return {
    total_active: parseInt(row.total_active, 10) || 0,
    total_expired: parseInt(row.total_expired, 10) || 0,
    total_deleted: parseInt(row.total_deleted, 10) || 0,
    total_bytes_active: parseInt(row.total_bytes_active, 10) || 0,
  };
}

/**
 * Extend TTL for an object (if owner requests more time with additional payment)
 */
export async function extendObjectTtl(bucket: string, key: string, newExpiresAt: Date): Promise<boolean> {
  const result = await query(
    `UPDATE x402_ephemeral_objects
     SET expires_at = $1
     WHERE bucket = $2 AND object_key = $3 AND deleted = 0`,
    [newExpiresAt.toISOString(), bucket, key]
  );

  return (result.rowCount || 0) > 0;
}
