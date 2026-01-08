/**
 * Cleanup Cron Service
 *
 * Periodically cleans up expired ephemeral objects from S3.
 */

import { getExpiredObjects, markObjectDeleted } from '../database/repositories/ephemeralObjects.js';
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
 * Run a single cleanup cycle
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

    console.log(`[cleanup] Processing ${expiredObjects.length} expired objects`);

    for (const obj of expiredObjects) {
      try {
        // Delete from S3
        // Note: For cleanup, we need admin credentials or a service account
        // Since we're using pass-through proxy, we'll need to implement
        // a separate delete mechanism or use the S3 admin API directly
        const deleteSuccess = await deleteFromS3(obj.bucket, obj.object_key);

        if (deleteSuccess) {
          markObjectDeleted(obj.id);
          deleted++;
          console.log(`[cleanup] Deleted: ${obj.bucket}/${obj.object_key}`);
        } else {
          markObjectDeleted(obj.id, 'Delete failed');
          errors++;
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[cleanup] Error deleting ${obj.bucket}/${obj.object_key}:`, errorMsg);
        markObjectDeleted(obj.id, errorMsg);
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
    console.log(`[cleanup] Completed in ${duration}ms: ${deleted} deleted, ${errors} errors`);
  }
}

/**
 * Delete an object from S3 using admin credentials
 *
 * Note: This requires separate admin credentials since we can't use
 * the user's JWT for cleanup. The S3 backend should expose an admin
 * delete endpoint or we need direct MinIO access.
 */
async function deleteFromS3(bucket: string, key: string): Promise<boolean> {
  try {
    // For now, we'll call the S3 backend directly
    // In production, this should use admin credentials
    const url = `${config.s3BackendUrl}/${bucket}/${key}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        // Note: Need to add admin auth here
        // This is a placeholder - real implementation needs admin creds
        'X-Cleanup-Service': 'x402-gateway',
      },
    });

    // 204 No Content or 200 OK means success
    // 404 Not Found also means "successfully deleted" (already gone)
    return response.status === 204 || response.status === 200 || response.status === 404;

  } catch (error) {
    console.error(`[cleanup] S3 delete error for ${bucket}/${key}:`, error);
    return false;
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

  for (const obj of expiredObjects) {
    try {
      const success = await deleteFromS3(obj.bucket, obj.object_key);
      if (success) {
        markObjectDeleted(obj.id);
        deleted++;
      } else {
        markObjectDeleted(obj.id, 'Delete failed');
        errors++;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      markObjectDeleted(obj.id, errorMsg);
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
