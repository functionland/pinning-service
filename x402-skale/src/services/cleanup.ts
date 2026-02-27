/**
 * Cleanup Cron Service
 *
 * Periodically cleans up expired ephemeral objects by deleting individual
 * objects from S3 using the admin token.
 *
 * Two-phase cleanup:
 * - Phase 1: Aggressive cleanup of unpaid objects (objects where payment was never settled)
 * - Phase 2: Normal TTL-based cleanup for paid objects whose TTL has expired
 */

import { getExpiredObjects, getUnpaidExpiredObjects, markObjectDeleted, markDeleteFailed } from '../database/repositories/ephemeralObjects.js';
import { deleteObject } from './s3Proxy.js';
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
 * Delete a single object from S3 using admin token
 */
async function deleteObjectFromS3(bucket: string, key: string): Promise<boolean> {
  try {
    console.log(`[cleanup] Deleting object: ${bucket}/${key}`);
    const success = await deleteObject(bucket, key, `Bearer ${config.s3AdminToken}`);

    if (success) {
      console.log(`[cleanup] Object deleted: ${bucket}/${key}`);
    } else {
      console.error(`[cleanup] Failed to delete object: ${bucket}/${key}`);
    }

    return success;
  } catch (error) {
    console.error(`[cleanup] Error deleting object ${bucket}/${key}:`, error);
    return false;
  }
}

/**
 * Run a single cleanup cycle
 *
 * Phase 1: Aggressive cleanup of unpaid objects (configurable threshold, default 30 min)
 * Phase 2: Normal TTL-based cleanup for paid/settled objects
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
    // Phase 1: Aggressive cleanup of unpaid objects
    // These are objects where payment was never completed (no payment log, or pending/failed)
    const unpaidObjects = await getUnpaidExpiredObjects(
      config.cleanupUnpaidThresholdMinutes,
      CLEANUP_BATCH_SIZE
    );

    if (unpaidObjects.length > 0) {
      console.log(`[cleanup] Phase 1: Processing ${unpaidObjects.length} unpaid objects (>${config.cleanupUnpaidThresholdMinutes}min old)`);

      for (const obj of unpaidObjects) {
        try {
          const success = await deleteObjectFromS3(obj.bucket, obj.object_key);
          if (success) {
            await markObjectDeleted(obj.id);
            deleted++;
          } else {
            await markDeleteFailed(obj.id, 'S3 delete failed');
            errors++;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[cleanup] Error cleaning up unpaid object ${obj.bucket}/${obj.object_key}:`, errorMsg);
          await markDeleteFailed(obj.id, errorMsg).catch(() => {});
          errors++;
        }
      }
    }

    // Phase 2: Normal TTL-based cleanup for paid/settled objects
    const expiredObjects = await getExpiredObjects(CLEANUP_BATCH_SIZE);

    if (expiredObjects.length > 0) {
      console.log(`[cleanup] Phase 2: Processing ${expiredObjects.length} expired objects`);

      for (const obj of expiredObjects) {
        try {
          const success = await deleteObjectFromS3(obj.bucket, obj.object_key);
          if (success) {
            await markObjectDeleted(obj.id);
            deleted++;
          } else {
            await markDeleteFailed(obj.id, 'S3 delete failed');
            errors++;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[cleanup] Error cleaning up expired object ${obj.bucket}/${obj.object_key}:`, errorMsg);
          await markDeleteFailed(obj.id, errorMsg).catch(() => {});
          errors++;
        }
      }
    }

  } catch (error) {
    console.error('[cleanup] Fatal error:', error);
  } finally {
    isRunning = false;
  }

  const duration = Date.now() - startTime;
  if (deleted > 0 || errors > 0) {
    console.log(`[cleanup] Completed in ${duration}ms: ${deleted} objects deleted, ${errors} errors`);
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

  for (const obj of expiredObjects) {
    try {
      const success = await deleteObjectFromS3(obj.bucket, obj.object_key);
      if (success) {
        await markObjectDeleted(obj.id);
        deleted++;
      } else {
        await markDeleteFailed(obj.id, 'S3 delete failed');
        errors++;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await markDeleteFailed(obj.id, errorMsg).catch(() => {});
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
