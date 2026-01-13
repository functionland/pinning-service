/**
 * Payment Logs Repository
 *
 * Manages x402 payment audit logs in the database (PostgreSQL).
 */

import { query } from '../index.js';
import type { PaymentLog, X402PaymentInfo } from '../../types/index.js';

/**
 * Create a new payment log entry
 */
export async function createPaymentLog(payment: X402PaymentInfo, bucket?: string, key?: string): Promise<void> {
  await query(
    `INSERT INTO x402_payment_logs (
      payment_id, wallet, amount_raw, amount_usdc, network,
      bucket, object_key, size_bytes, size_mb, ttl_seconds, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
    [
      payment.paymentId,
      payment.payer.toLowerCase(),
      payment.amount,
      payment.amountUsdc,
      payment.network,
      bucket || null,
      key || null,
      payment.sizeBytes,
      payment.sizeMb,
      payment.ttlSeconds,
    ]
  );
}

/**
 * Update payment status to verified
 */
export async function markPaymentVerified(paymentId: string): Promise<void> {
  await query(
    `UPDATE x402_payment_logs
     SET status = 'verified', verified_at = NOW()
     WHERE payment_id = $1`,
    [paymentId]
  );
}

/**
 * Update payment status to settled with transaction hash
 */
export async function markPaymentSettled(paymentId: string, txHash?: string): Promise<void> {
  await query(
    `UPDATE x402_payment_logs
     SET status = 'settled', tx_hash = $1, settled_at = NOW()
     WHERE payment_id = $2`,
    [txHash || null, paymentId]
  );
}

/**
 * Update payment status to failed with error message
 */
export async function markPaymentFailed(paymentId: string, errorMessage: string): Promise<void> {
  await query(
    `UPDATE x402_payment_logs
     SET status = 'failed', error_message = $1
     WHERE payment_id = $2`,
    [errorMessage, paymentId]
  );
}

/**
 * Get payment log by ID
 */
export async function getPaymentLog(paymentId: string): Promise<PaymentLog | undefined> {
  const result = await query<PaymentLog>(
    `SELECT * FROM x402_payment_logs WHERE payment_id = $1`,
    [paymentId]
  );
  return result.rows[0];
}

/**
 * Get payment logs for a wallet
 */
export async function getPaymentLogsByWallet(wallet: string, limit = 50): Promise<PaymentLog[]> {
  const result = await query<PaymentLog>(
    `SELECT * FROM x402_payment_logs
     WHERE wallet = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [wallet.toLowerCase(), limit]
  );
  return result.rows;
}

/**
 * Get recent payment logs
 */
export async function getRecentPaymentLogs(limit = 100): Promise<PaymentLog[]> {
  const result = await query<PaymentLog>(
    `SELECT * FROM x402_payment_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Get payment statistics for a date
 */
export async function getPaymentStats(date: string): Promise<{
  total_payments: number;
  total_settled: number;
  total_failed: number;
  total_usdc: number;
  total_bytes: number;
}> {
  const result = await query<{
    total_payments: string;
    total_settled: string;
    total_failed: string;
    total_usdc: string;
    total_bytes: string;
  }>(
    `SELECT
      COUNT(*) as total_payments,
      SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) as total_settled,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN amount_usdc ELSE 0 END), 0) as total_usdc,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN size_bytes ELSE 0 END), 0) as total_bytes
    FROM x402_payment_logs
    WHERE date(created_at) = $1`,
    [date]
  );

  const row = result.rows[0];
  return {
    total_payments: parseInt(row.total_payments, 10) || 0,
    total_settled: parseInt(row.total_settled, 10) || 0,
    total_failed: parseInt(row.total_failed, 10) || 0,
    total_usdc: parseFloat(row.total_usdc) || 0,
    total_bytes: parseInt(row.total_bytes, 10) || 0,
  };
}
