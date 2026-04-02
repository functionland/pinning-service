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

// Configuration (from env or defaults)
const FREE_TIER_BYTES = parseInt(process.env.FREE_TIER_BYTES || '524288000'); // 500MB
const FULA_PER_GB_MONTH = parseFloat(process.env.FULA_PER_GB_MONTH || '3');
const HOURS_PER_MONTH = 720;

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

// Process deduction for a single user
async function processUserDeduction(userId: string, storageBytes: number): Promise<{
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

    // Get or create user credits
    const creditsResult = await client.query<{ balance_fula: number; is_suspended: number }>(
      'SELECT balance_fula, is_suspended FROM user_credits WHERE user_id = $1',
      [userId]
    );
    const credits = creditsResult.rows[0];

    let currentBalance = credits?.balance_fula || 0;
    let isSuspended = credits?.is_suspended === 1;

    // Skip if already suspended (they'll be unsuspended when they add credits)
    if (isSuspended) {
      await client.query('COMMIT');
      return { deducted: false, amount: 0, suspended: true };
    }

    const newBalance = currentBalance - deductionAmount;
    const shouldSuspend = newBalance < 0;

    if (credits) {
      // Update existing record
      await client.query(
        `UPDATE user_credits
         SET balance_fula = $1,
             total_deducted_fula = total_deducted_fula + $2,
             last_deduction_at = NOW(),
             is_suspended = $3,
             suspended_at = CASE WHEN $4 THEN NOW() ELSE suspended_at END,
             updated_at = NOW()
         WHERE user_id = $5`,
        [newBalance, deductionAmount, shouldSuspend ? 1 : 0, shouldSuspend, userId]
      );
    } else {
      // Create new record with negative balance (dual-write: user_id + user_email)
      await client.query(
        `INSERT INTO user_credits (user_id, user_email, balance_fula, total_deducted_fula, is_suspended, suspended_at, last_deduction_at)
         VALUES ($1, $1, $2, $3, $4, CASE WHEN $5 THEN NOW() ELSE NULL END, NOW())`,
        [userId, newBalance, deductionAmount, shouldSuspend ? 1 : 0, shouldSuspend]
      );
    }

    // Log the deduction (dual-write: user_id + user_email)
    await client.query(
      `INSERT INTO credit_history (user_id, user_email, tx_type, amount_fula, balance_after, reference_id)
       VALUES ($1, $1, 'hourly_deduction', $2, $3, $4)`,
      [userId, -deductionAmount, newBalance, new Date().toISOString()]
    );

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

export function startDeductionJob(intervalMs: number = 60 * 60 * 1000): void {
  if (deductionInterval) {
    console.log('[deductionJob] Deduction job already running');
    return;
  }

  console.log(`[deductionJob] Starting deduction job with ${intervalMs / 1000 / 60}min interval`);

  // Don't run immediately on start - wait for first interval
  // This prevents double-deduction if server restarts

  deductionInterval = setInterval(() => {
    runDeductionJob().catch(err => console.error('[deductionJob] Error:', err));
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
