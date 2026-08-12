/**
 * Hourly Deduction Cron Service
 *
 * Calculates and deducts FULA credits for users over the free tier.
 * Formula: (storageGB - 0.5) * 3 / 720 FULA per hour
 *
 * If balance goes negative, user is suspended.
 * Runs every hour.
 * Uses PostgreSQL for database operations.
 */

import { query, getClient } from '../database/postgres.js';
import { leaseGate } from './leaderLease.js';

// Configuration (from env or defaults)
const FREE_TIER_BYTES = parseInt(process.env.FREE_TIER_BYTES || '524288000'); // 500MB
const FULA_PER_GB_MONTH = parseFloat(process.env.FULA_PER_GB_MONTH || '3');
const HOURS_PER_MONTH = 720;

// FM-2 (federated masters): when true, the deduction uses a deterministic
// per-hour reference_id and the credit_history INSERT becomes the dedup gate
// (ON CONFLICT on migration 018's partial UNIQUE index) — N masters running
// this cron concurrently deduct exactly once per (user, hour). Default OFF:
// legacy single-master behavior is byte-identical when dark.
const BILLING_IDEMPOTENCY = process.env.BILLING_IDEMPOTENCY === 'true';

/** Deterministic UTC hour bucket, e.g. 'hour:2026-06-12T14'. */
export function currentHourBucket(d: Date = new Date()): string {
  return `hour:${d.toISOString().slice(0, 13)}`;
}

// User storage info
interface UserStorage {
  userId: string;
  totalSize: number;
}

// Get all users with storage over free tier
async function getUsersOverFreeTier(): Promise<UserStorage[]> {
  // Query pins table for users with total storage > free tier
  const result = await query<{ user_id: string; totalsize: string }>(
    `SELECT user_id, SUM(size) as totalsize
     FROM pins
     WHERE status != 'deleted' AND user_id IS NOT NULL
     GROUP BY user_id
     HAVING SUM(size) > $1`,
    [FREE_TIER_BYTES]
  );

  return result.rows.map(u => ({
    userId: u.user_id,
    totalSize: parseInt(u.totalsize || '0', 10),
  }));
}

// Calculate hourly deduction for a given storage size
function calculateHourlyDeduction(totalBytes: number): number {
  const totalGB = totalBytes / (1024 * 1024 * 1024);
  const freeTierGB = FREE_TIER_BYTES / (1024 * 1024 * 1024);
  const billableGB = Math.max(0, totalGB - freeTierGB);

  // Formula: billableGB * FULA_PER_GB_MONTH / HOURS_PER_MONTH
  return billableGB * FULA_PER_GB_MONTH / HOURS_PER_MONTH;
}

// Process deduction for a single user.
// Exported as a test seam: the FM-2 e2e/integration suites race two calls to
// prove the (user, hour) idempotency gate under real Postgres.
export async function processUserDeduction(userId: string, storageBytes: number): Promise<{
  deducted: boolean;
  amount: number;
  suspended: boolean;
}> {
  const deductionAmount = calculateHourlyDeduction(storageBytes);

  if (deductionAmount <= 0) {
    return { deducted: false, amount: 0, suspended: false };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Row lock prevents concurrent deduction races
    const creditsResult = await client.query<{ balance_fula: number; is_suspended: number }>(
      'SELECT balance_fula, is_suspended FROM user_credits WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const credits = creditsResult.rows[0];

    // Skip if already suspended (they'll be unsuspended when they add credits)
    if (credits?.is_suspended === 1) {
      await client.query('COMMIT');
      return { deducted: false, amount: 0, suspended: true };
    }

    const currentBalance = credits?.balance_fula || 0;
    const newBalance = currentBalance - deductionAmount;
    const shouldSuspend = newBalance < 0;

    if (BILLING_IDEMPOTENCY) {
      // FM-2: insert the history row FIRST as the idempotency gate. The partial
      // UNIQUE index (migration 018) on (user_id, reference_id) WHERE
      // tx_type='hourly_deduction' arbitrates: if another master already
      // deducted this (user, hour), this no-ops and we leave the balance alone.
      // The FOR UPDATE row lock above serializes concurrent attempts so the
      // loser observes the conflict, not a race.
      const gate = await client.query(
        `INSERT INTO credit_history (user_id, tx_type, amount_fula, balance_after, reference_id)
         VALUES ($1, 'hourly_deduction', $2, $3, $4)
         ON CONFLICT (user_id, reference_id) WHERE tx_type = 'hourly_deduction' DO NOTHING
         RETURNING id`,
        [userId, -deductionAmount, newBalance, currentHourBucket()]
      );
      if ((gate.rowCount || 0) === 0) {
        await client.query('COMMIT');
        return { deducted: false, amount: 0, suspended: false };
      }
    }

    if (credits) {
      // Atomic deduction on existing record
      await client.query(
        `UPDATE user_credits
         SET balance_fula = balance_fula - $1,
             total_deducted_fula = total_deducted_fula + $1,
             last_deduction_at = NOW(),
             is_suspended = $2,
             suspended_at = CASE WHEN $3 THEN NOW() ELSE suspended_at END,
             updated_at = NOW()
         WHERE user_id = $4`,
        [deductionAmount, shouldSuspend ? 1 : 0, shouldSuspend, userId]
      );
    } else {
      // Create new record with negative balance
      await client.query(
        `INSERT INTO user_credits (user_id, balance_fula, total_deducted_fula, is_suspended, suspended_at, last_deduction_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN NOW() ELSE NULL END, NOW())`,
        [userId, newBalance, deductionAmount, shouldSuspend ? 1 : 0, shouldSuspend]
      );
    }

    if (!BILLING_IDEMPOTENCY) {
      // Legacy path: history row appended after the balance update, with a
      // timestamp reference_id (not idempotent — single-master only).
      await client.query(
        `INSERT INTO credit_history (user_id, tx_type, amount_fula, balance_after, reference_id)
         VALUES ($1, 'hourly_deduction', $2, $3, $4)`,
        [userId, -deductionAmount, newBalance, new Date().toISOString()]
      );
    }

    await client.query('COMMIT');
    return { deducted: true, amount: deductionAmount, suspended: shouldSuspend };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Check if users should be unsuspended (e.g., they unpinned content)
async function checkForUnsuspension(): Promise<number> {
  // Get suspended users
  const suspendedResult = await query<{ user_id: string }>(
    'SELECT user_id FROM user_credits WHERE is_suspended = 1 AND user_id IS NOT NULL'
  );

  let unsuspendedCount = 0;

  for (const user of suspendedResult.rows) {
    // Check their current storage
    const storageResult = await query<{ totalsize: string }>(
      `SELECT COALESCE(SUM(size), 0) as totalsize
       FROM pins
       WHERE user_id = $1 AND status != 'deleted'`,
      [user.user_id]
    );
    const storage = parseInt(storageResult.rows[0]?.totalsize || '0', 10);

    // If under free tier, unsuspend them
    if (storage < FREE_TIER_BYTES) {
      await query(
        `UPDATE user_credits
         SET is_suspended = 0, suspended_at = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [user.user_id]
      );

      console.log(`[deductionJob] Unsuspended user ${user.user_id.slice(0, 8)}... (now under free tier)`);
      unsuspendedCount++;
    } else {
      // Check if they have positive balance
      const creditsResult = await query<{ balance_fula: number }>(
        'SELECT balance_fula FROM user_credits WHERE user_id = $1',
        [user.user_id]
      );
      const credits = creditsResult.rows[0];

      if (credits && credits.balance_fula > 0) {
        await query(
          `UPDATE user_credits
           SET is_suspended = 0, suspended_at = NULL, updated_at = NOW()
           WHERE user_id = $1`,
          [user.user_id]
        );

        console.log(`[deductionJob] Unsuspended user ${user.user_id.slice(0, 8)}... (has positive balance)`);
        unsuspendedCount++;
      }
    }
  }

  return unsuspendedCount;
}

// Main deduction function
export async function runDeductionJob(): Promise<void> {
  console.log('[deductionJob] Starting hourly deduction...');

  // First, check for users who should be unsuspended
  const unsuspended = await checkForUnsuspension();
  if (unsuspended > 0) {
    console.log(`[deductionJob] Unsuspended ${unsuspended} users`);
  }

  // Get users over free tier
  const users = await getUsersOverFreeTier();

  if (users.length === 0) {
    console.log('[deductionJob] No users over free tier');
    return;
  }

  let totalDeducted = 0;
  let usersDeducted = 0;
  let usersSuspended = 0;

  for (const user of users) {
    try {
      const result = await processUserDeduction(user.userId, user.totalSize);

      if (result.deducted) {
        totalDeducted += result.amount;
        usersDeducted++;
      }
      if (result.suspended) {
        usersSuspended++;
      }
    } catch (error) {
      console.error(`[deductionJob] Error processing user ${user.userId.slice(0, 8)}...:`, error);
    }
  }

  console.log(`[deductionJob] Complete. Deducted ${totalDeducted.toFixed(6)} FULA from ${usersDeducted} users. Suspended: ${usersSuspended}`);
}

// Start the cron job
let deductionInterval: NodeJS.Timeout | null = null;
let isProcessing = false;

export function startDeductionJob(intervalMs: number = 60 * 60 * 1000): void {
  if (deductionInterval) {
    console.log('[deductionJob] Deduction job already running');
    return;
  }

  console.log(`[deductionJob] Starting deduction job with ${intervalMs / 1000 / 60}min interval`);

  // Don't run immediately on start - wait for first interval
  // This prevents double-deduction if server restarts

  deductionInterval = setInterval(async () => {
    if (isProcessing) {
      console.log('[deductionJob] Previous job still running, skipping');
      return;
    }
    isProcessing = true;
    try {
      // Federated masters: only the lease holder runs the tick (no-op when
      // CRON_LEADER_LEASE is off — legacy behavior).
      if (await leaseGate('deductionJob')) {
        await runDeductionJob();
      }
    } catch (err) {
      console.error('[deductionJob] Error:', err);
    } finally {
      isProcessing = false;
    }
  }, intervalMs);
}

export function stopDeductionJob(): void {
  if (deductionInterval) {
    clearInterval(deductionInterval);
    deductionInterval = null;
    console.log('[deductionJob] Deduction job stopped');
  }
}

// Export for manual triggering (admin use)
export { calculateHourlyDeduction, FREE_TIER_BYTES, FULA_PER_GB_MONTH };
