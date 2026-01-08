/**
 * Payment Logs Repository
 *
 * Manages x402 payment audit logs in the database.
 */

import { getDatabase } from '../index.js';
import type { PaymentLog, X402PaymentInfo } from '../../types/index.js';

/**
 * Create a new payment log entry
 */
export function createPaymentLog(payment: X402PaymentInfo, bucket?: string, key?: string): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO x402_payment_logs (
      payment_id, wallet, amount_raw, amount_usdc, network,
      bucket, object_key, size_bytes, size_mb, ttl_seconds, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    payment.paymentId,
    payment.payer.toLowerCase(),
    payment.amount,
    payment.amountUsdc,
    payment.network,
    bucket || null,
    key || null,
    payment.sizeBytes,
    payment.sizeMb,
    payment.ttlSeconds
  );
}

/**
 * Update payment status to verified
 */
export function markPaymentVerified(paymentId: string): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE x402_payment_logs
    SET status = 'verified', verified_at = CURRENT_TIMESTAMP
    WHERE payment_id = ?
  `).run(paymentId);
}

/**
 * Update payment status to settled with transaction hash
 */
export function markPaymentSettled(paymentId: string, txHash?: string): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE x402_payment_logs
    SET status = 'settled', tx_hash = ?, settled_at = CURRENT_TIMESTAMP
    WHERE payment_id = ?
  `).run(txHash || null, paymentId);
}

/**
 * Update payment status to failed with error message
 */
export function markPaymentFailed(paymentId: string, errorMessage: string): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE x402_payment_logs
    SET status = 'failed', error_message = ?
    WHERE payment_id = ?
  `).run(errorMessage, paymentId);
}

/**
 * Get payment log by ID
 */
export function getPaymentLog(paymentId: string): PaymentLog | undefined {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM x402_payment_logs WHERE payment_id = ?
  `).get(paymentId) as PaymentLog | undefined;
}

/**
 * Get payment logs for a wallet
 */
export function getPaymentLogsByWallet(wallet: string, limit = 50): PaymentLog[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM x402_payment_logs
    WHERE wallet = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(wallet.toLowerCase(), limit) as PaymentLog[];
}

/**
 * Get recent payment logs
 */
export function getRecentPaymentLogs(limit = 100): PaymentLog[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM x402_payment_logs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as PaymentLog[];
}

/**
 * Get payment statistics for a date
 */
export function getPaymentStats(date: string): {
  total_payments: number;
  total_settled: number;
  total_failed: number;
  total_usdc: number;
  total_bytes: number;
} {
  const db = getDatabase();

  const result = db.prepare(`
    SELECT
      COUNT(*) as total_payments,
      SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) as total_settled,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN amount_usdc ELSE 0 END), 0) as total_usdc,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN size_bytes ELSE 0 END), 0) as total_bytes
    FROM x402_payment_logs
    WHERE date(created_at) = ?
  `).get(date) as {
    total_payments: number;
    total_settled: number;
    total_failed: number;
    total_usdc: number;
    total_bytes: number;
  };

  return result;
}
