/**
 * Hourly Deduction Cron Service
 *
 * Calculates and deducts FULA credits for users over the free tier.
 * Formula: (storageGB - 0.5) * 3 / 720 FULA per hour
 *
 * If balance goes negative, user is suspended.
 * Runs every hour.
 */

import Database from 'better-sqlite3';

// Configuration (from env or defaults)
const FREE_TIER_BYTES = parseInt(process.env.FREE_TIER_BYTES || '524288000'); // 500MB
const FULA_PER_GB_MONTH = parseFloat(process.env.FULA_PER_GB_MONTH || '3');
const HOURS_PER_MONTH = 720;

// User storage info
interface UserStorage {
  username: string;
  totalSize: number;
}

// Get all users with storage over free tier
function getUsersOverFreeTier(db: Database.Database): UserStorage[] {
  // Query pins table for users with total storage > free tier
  const users = db.prepare(`
    SELECT username, SUM(size) as totalSize
    FROM pins
    WHERE status != 'deleted'
    GROUP BY username
    HAVING SUM(size) > ?
  `).all(FREE_TIER_BYTES) as Array<{ username: string; totalSize: number }>;

  return users.map(u => ({
    username: u.username,
    totalSize: u.totalSize || 0,
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
function processUserDeduction(db: Database.Database, username: string, storageBytes: number): {
  deducted: boolean;
  amount: number;
  suspended: boolean;
} {
  const deductionAmount = calculateHourlyDeduction(storageBytes);

  if (deductionAmount <= 0) {
    return { deducted: false, amount: 0, suspended: false };
  }

  const transaction = db.transaction(() => {
    // Get or create user credits
    const credits = db.prepare(`
      SELECT balance_fula, is_suspended FROM user_credits WHERE user_email = ?
    `).get(username) as { balance_fula: number; is_suspended: number } | undefined;

    let currentBalance = credits?.balance_fula || 0;
    let isSuspended = credits?.is_suspended === 1;

    // Skip if already suspended (they'll be unsuspended when they add credits)
    if (isSuspended) {
      return { deducted: false, amount: 0, suspended: true };
    }

    const newBalance = currentBalance - deductionAmount;
    const shouldSuspend = newBalance < 0;

    if (credits) {
      // Update existing record
      db.prepare(`
        UPDATE user_credits
        SET balance_fula = ?,
            total_deducted_fula = total_deducted_fula + ?,
            last_deduction_at = CURRENT_TIMESTAMP,
            is_suspended = ?,
            suspended_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE suspended_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_email = ?
      `).run(newBalance, deductionAmount, shouldSuspend ? 1 : 0, shouldSuspend ? 1 : 0, username);
    } else {
      // Create new record with negative balance
      db.prepare(`
        INSERT INTO user_credits (user_email, balance_fula, total_deducted_fula, is_suspended, suspended_at, last_deduction_at)
        VALUES (?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
      `).run(username, newBalance, deductionAmount, shouldSuspend ? 1 : 0, shouldSuspend ? 1 : 0);
    }

    // Log the deduction
    db.prepare(`
      INSERT INTO credit_history (user_email, tx_type, amount_fula, balance_after, reference_id)
      VALUES (?, 'hourly_deduction', ?, ?, ?)
    `).run(username, -deductionAmount, newBalance, new Date().toISOString());

    return { deducted: true, amount: deductionAmount, suspended: shouldSuspend };
  });

  return transaction();
}

// Check if users should be unsuspended (e.g., they unpinned content)
function checkForUnsuspension(db: Database.Database): number {
  // Get suspended users
  const suspendedUsers = db.prepare(`
    SELECT user_email FROM user_credits WHERE is_suspended = 1
  `).all() as Array<{ user_email: string }>;

  let unsuspendedCount = 0;

  for (const user of suspendedUsers) {
    // Check their current storage
    const storage = db.prepare(`
      SELECT COALESCE(SUM(size), 0) as totalSize
      FROM pins
      WHERE username = ? AND status != 'deleted'
    `).get(user.user_email) as { totalSize: number };

    // If under free tier, unsuspend them
    if (storage.totalSize < FREE_TIER_BYTES) {
      db.prepare(`
        UPDATE user_credits
        SET is_suspended = 0, suspended_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE user_email = ?
      `).run(user.user_email);

      console.log(`[deductionJob] Unsuspended ${user.user_email} (now under free tier)`);
      unsuspendedCount++;
    } else {
      // Check if they have positive balance
      const credits = db.prepare(`
        SELECT balance_fula FROM user_credits WHERE user_email = ?
      `).get(user.user_email) as { balance_fula: number } | undefined;

      if (credits && credits.balance_fula > 0) {
        db.prepare(`
          UPDATE user_credits
          SET is_suspended = 0, suspended_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE user_email = ?
        `).run(user.user_email);

        console.log(`[deductionJob] Unsuspended ${user.user_email} (has positive balance)`);
        unsuspendedCount++;
      }
    }
  }

  return unsuspendedCount;
}

// Main deduction function
export async function runDeductionJob(db: Database.Database): Promise<void> {
  console.log('[deductionJob] Starting hourly deduction...');

  // First, check for users who should be unsuspended
  const unsuspended = checkForUnsuspension(db);
  if (unsuspended > 0) {
    console.log(`[deductionJob] Unsuspended ${unsuspended} users`);
  }

  // Get users over free tier
  const users = getUsersOverFreeTier(db);

  if (users.length === 0) {
    console.log('[deductionJob] No users over free tier');
    return;
  }

  let totalDeducted = 0;
  let usersDeducted = 0;
  let usersSuspended = 0;

  for (const user of users) {
    const result = processUserDeduction(db, user.username, user.totalSize);

    if (result.deducted) {
      totalDeducted += result.amount;
      usersDeducted++;
    }
    if (result.suspended) {
      usersSuspended++;
    }
  }

  console.log(`[deductionJob] Complete. Deducted ${totalDeducted.toFixed(6)} FULA from ${usersDeducted} users. Suspended: ${usersSuspended}`);
}

// Start the cron job
let deductionInterval: NodeJS.Timeout | null = null;

export function startDeductionJob(db: Database.Database, intervalMs: number = 60 * 60 * 1000): void {
  if (deductionInterval) {
    console.log('[deductionJob] Deduction job already running');
    return;
  }

  console.log(`[deductionJob] Starting deduction job with ${intervalMs / 1000 / 60}min interval`);

  // Don't run immediately on start - wait for first interval
  // This prevents double-deduction if server restarts

  deductionInterval = setInterval(() => {
    runDeductionJob(db).catch(err => console.error('[deductionJob] Error:', err));
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
