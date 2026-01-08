/**
 * Ephemeral Objects Repository
 *
 * Manages temporary object tracking for TTL-based cleanup.
 */

import { getDatabase } from '../index.js';
import type { EphemeralObject } from '../../types/index.js';

/**
 * Track a new ephemeral object
 */
export function trackEphemeralObject(params: {
  bucket: string;
  key: string;
  wallet: string;
  sizeBytes: number;
  sizeMb: number;
  paymentId?: string;
  expiresAt: Date;
}): void {
  const db = getDatabase();

  db.prepare(`
    INSERT OR REPLACE INTO x402_ephemeral_objects (
      bucket, object_key, wallet, size_bytes, size_mb, payment_id, expires_at, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    params.bucket,
    params.key,
    params.wallet.toLowerCase(),
    params.sizeBytes,
    params.sizeMb,
    params.paymentId || null,
    params.expiresAt.toISOString()
  );
}

/**
 * Get expired objects that need to be cleaned up
 */
export function getExpiredObjects(limit = 100): EphemeralObject[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM x402_ephemeral_objects
    WHERE expires_at < datetime('now')
      AND deleted = 0
    ORDER BY expires_at ASC
    LIMIT ?
  `).all(limit) as EphemeralObject[];
}

/**
 * Mark an object as deleted
 */
export function markObjectDeleted(id: number, error?: string): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE x402_ephemeral_objects
    SET deleted = 1, deleted_at = CURRENT_TIMESTAMP, delete_error = ?
    WHERE id = ?
  `).run(error || null, id);
}

/**
 * Get ephemeral object by bucket and key
 */
export function getEphemeralObject(bucket: string, key: string): EphemeralObject | undefined {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM x402_ephemeral_objects
    WHERE bucket = ? AND object_key = ? AND deleted = 0
  `).get(bucket, key) as EphemeralObject | undefined;
}

/**
 * Get all ephemeral objects for a wallet
 */
export function getEphemeralObjectsByWallet(wallet: string, limit = 50): EphemeralObject[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM x402_ephemeral_objects
    WHERE wallet = ? AND deleted = 0
    ORDER BY created_at DESC
    LIMIT ?
  `).all(wallet.toLowerCase(), limit) as EphemeralObject[];
}

/**
 * Delete ephemeral object record (hard delete, for cleanup)
 */
export function deleteEphemeralObjectRecord(id: number): void {
  const db = getDatabase();

  db.prepare(`
    DELETE FROM x402_ephemeral_objects WHERE id = ?
  `).run(id);
}

/**
 * Get cleanup statistics
 */
export function getCleanupStats(): {
  total_active: number;
  total_expired: number;
  total_deleted: number;
  total_bytes_active: number;
} {
  const db = getDatabase();

  return db.prepare(`
    SELECT
      SUM(CASE WHEN deleted = 0 AND expires_at >= datetime('now') THEN 1 ELSE 0 END) as total_active,
      SUM(CASE WHEN deleted = 0 AND expires_at < datetime('now') THEN 1 ELSE 0 END) as total_expired,
      SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) as total_deleted,
      COALESCE(SUM(CASE WHEN deleted = 0 AND expires_at >= datetime('now') THEN size_bytes ELSE 0 END), 0) as total_bytes_active
    FROM x402_ephemeral_objects
  `).get() as {
    total_active: number;
    total_expired: number;
    total_deleted: number;
    total_bytes_active: number;
  };
}

/**
 * Extend TTL for an object (if owner requests more time with additional payment)
 */
export function extendObjectTtl(bucket: string, key: string, newExpiresAt: Date): boolean {
  const db = getDatabase();

  const result = db.prepare(`
    UPDATE x402_ephemeral_objects
    SET expires_at = ?
    WHERE bucket = ? AND object_key = ? AND deleted = 0
  `).run(newExpiresAt.toISOString(), bucket, key);

  return result.changes > 0;
}
