/**
 * Cleanup Cron Service
 *
 * Periodically cleans up expired ephemeral objects by deleting users from S3.
 * When a user's TTL expires, we delete the entire user via S3 admin API,
 * which cascades and deletes all their CIDs automatically.
 */

import { getExpiredObjects, markObjectDeleted, markAllUserObjectsDeleted } from '../database/repositories/ephemeralObjects.js';
import { config } from '../config/index.js';

// Cleanup interval (60 seconds)
const CLEANUP_INTERVAL_MS = 60 * 1000;

// Batch size for cleanup
const CLEANUP_BATCH_SIZE = 50;

let cleanupTimer: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Start the cleanup cron job
 */
export function startCleanupCron(): void {
  if (cleanupTimer) {
    console.warn('[cleanup] Cron already running');
    return;
  }

  console.log('[cleanup] Starting cleanup cron (interval: 60s)');

  // Run immediately on start
  runCleanup().catch(console.error);

  // Schedule recurring runs
  cleanupTimer = setInterval(() => {
    runCleanup().catch(console.error);
  }, CLEANUP_INTERVAL_MS);
}

/**
 * Stop the cleanup cron job
 */
export function stopCleanupCron(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[cleanup] Cron stopped');
  }
}

/**
 * Delete user from S3 admin API
 * This deletes the user AND all their CIDs automatically (cascading delete)
 */
async function deleteUserFromS3(wallet: string): Promise<boolean> {
  // x402 users have email format: {wallet}@x402.gateway
  const email = `${wallet.toLowerCase()}@x402.gateway`;

  try {
    const url = `${config.s3BackendUrl}/admin/users/${encodeURIComponent(email)}`;
    console.log(`[cleanup] Deleting user: ${email}`);

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${config.s3AdminToken}`,
      },
    });

    // 200/204 = deleted, 404 = already gone (success either way)
    if (response.ok || response.status === 404) {
      console.log(`[cleanup] User deleted successfully: ${email}`);
      return true;
    }

    const errorText = await response.text();
    console.error(`[cleanup] S3 admin delete failed: ${response.status} ${errorText}`);
    return false;
  } catch (error) {
    console.error(`[cleanup] S3 delete user error for ${email}:`, error);
    return false;
  }
}

/**
 * Run a single cleanup cycle
 *
 * 1. Get wallets with expired objects
 * 2. Delete each user via S3 admin API (cascades to all CIDs)
 * 3. Mark all user's objects as deleted in database
 */
async function runCleanup(): Promise<void> {
  if (isRunning) {
    console.log('[cleanup] Previous run still in progress, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  let deleted = 0;
  let errors = 0;

  try {
    // Get expired objects
    const expiredObjects = getExpiredObjects(CLEANUP_BATCH_SIZE);

    if (expiredObjects.length === 0) {
      isRunning = false;
      return;
    }

    // Group by wallet to delete users (not individual objects)
    const wallets = [...new Set(expiredObjects.map(obj => obj.wallet))];
    console.log(`[cleanup] Processing ${wallets.length} users with ${expiredObjects.length} expired objects`);

    for (const wallet of wallets) {
      try {
        const success = await deleteUserFromS3(wallet);

        if (success) {
          // Mark ALL objects for this wallet as deleted in our database
          markAllUserObjectsDeleted(wallet);
          deleted++;
          console.log(`[cleanup] Cleaned up user: ${wallet}`);
        } else {
          errors++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[cleanup] Error cleaning up wallet ${wallet}:`, errorMsg);
        errors++;
      }
    }

  } catch (error) {
    console.error('[cleanup] Fatal error:', error);
  } finally {
    isRunning = false;
  }

  const duration = Date.now() - startTime;
  if (deleted > 0 || errors > 0) {
    console.log(`[cleanup] Completed in ${duration}ms: ${deleted} users deleted, ${errors} errors`);
  }
}

/**
 * Manually trigger cleanup (for testing)
 */
export async function triggerCleanup(): Promise<{
  deleted: number;
  errors: number;
  duration: number;
}> {
  const startTime = Date.now();
  let deleted = 0;
  let errors = 0;

  const expiredObjects = getExpiredObjects(100);

  // Group by wallet
  const wallets = [...new Set(expiredObjects.map(obj => obj.wallet))];

  for (const wallet of wallets) {
    try {
      const success = await deleteUserFromS3(wallet);
      if (success) {
        markAllUserObjectsDeleted(wallet);
        deleted++;
      } else {
        errors++;
      }
    } catch (error) {
      errors++;
    }
  }

  return {
    deleted,
    errors,
    duration: Date.now() - startTime,
  };
}

export default {
  startCleanupCron,
  stopCleanupCron,
  triggerCleanup,
};
