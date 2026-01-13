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
 *
 * @param userId - The user's identity (JWT sub claim, typically email like user@example.com)
 */
async function deleteUserFromS3(userId: string): Promise<boolean> {
  // userId is the JWT sub claim (e.g., ehsan6sha@gmail.com)
  // URL encode it because @ becomes %40
  try {
    const url = `${config.s3BackendUrl}/admin/users/${encodeURIComponent(userId)}`;
    console.log(`[cleanup] Deleting user: ${userId}`);

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${config.s3AdminToken}`,
      },
    });

    // 200/204 = deleted, 404 = already gone (success either way)
    if (response.ok || response.status === 404) {
      console.log(`[cleanup] User deleted successfully: ${userId}`);
      return true;
    }

    const errorText = await response.text();
    console.error(`[cleanup] S3 admin delete failed: ${response.status} ${errorText}`);
    return false;
  } catch (error) {
    console.error(`[cleanup] S3 delete user error for ${userId}:`, error);
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
    // Get expired objects (async)
    const expiredObjects = await getExpiredObjects(CLEANUP_BATCH_SIZE);

    if (expiredObjects.length === 0) {
      isRunning = false;
      return;
    }

    // Group by user ID to delete users (not individual objects)
    // wallet field stores the user_id (JWT sub claim, e.g., email)
    const userIds = [...new Set(expiredObjects.map(obj => obj.wallet))];
    console.log(`[cleanup] Processing ${userIds.length} users with ${expiredObjects.length} expired objects`);

    for (const userId of userIds) {
      try {
        const success = await deleteUserFromS3(userId);

        if (success) {
          // Mark ALL objects for this user as deleted in our database
          await markAllUserObjectsDeleted(userId);
          deleted++;
          console.log(`[cleanup] Cleaned up user: ${userId}`);
        } else {
          errors++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[cleanup] Error cleaning up user ${userId}:`, errorMsg);
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

  const expiredObjects = await getExpiredObjects(100);

  // Group by user ID (stored in wallet field)
  const userIds = [...new Set(expiredObjects.map(obj => obj.wallet))];

  for (const userId of userIds) {
    try {
      const success = await deleteUserFromS3(userId);
      if (success) {
        await markAllUserObjectsDeleted(userId);
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
