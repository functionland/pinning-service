/**
 * Generation Service
 *
 * Job queue orchestrator: manages concurrent generation jobs,
 * coordinates Claude API calls, IPFS publishing, and credit refunds.
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import {
  getGeneration,
  updateGenerationStatus,
  completeGeneration,
  failGeneration,
} from '../database/postgres.js';
import { generateWebsite } from './claudeService.js';
import { publishWebsite } from './ipfsService.js';
import { refundCredits } from './creditService.js';

// Active jobs tracker
const activeJobs = new Map<string, AbortController>();
const jobQueue: Array<{ jobId: string; userToken: string }> = [];

/**
 * Get count of currently active jobs
 */
export function getActiveJobCount(): number {
  return activeJobs.size;
}

/**
 * Get count of queued jobs
 */
export function getQueuedJobCount(): number {
  return jobQueue.length;
}

/**
 * Start a generation job (or queue if at capacity)
 */
export function startGeneration(jobId: string, userToken: string): void {
  if (activeJobs.size >= config.maxConcurrentJobs) {
    console.log(`[generation] Job ${jobId} queued (${activeJobs.size}/${config.maxConcurrentJobs} active)`);
    jobQueue.push({ jobId, userToken });
    return;
  }

  runJob(jobId, userToken);
}

/**
 * Run a generation job
 */
function runJob(jobId: string, userToken: string): void {
  const controller = new AbortController();
  activeJobs.set(jobId, controller);

  // Set up timeout
  const timeout = setTimeout(() => {
    console.warn(`[generation] Job ${jobId} timed out after ${config.jobTimeoutMs}ms`);
    controller.abort();
  }, config.jobTimeoutMs);

  // Run async worker
  executeJob(jobId, userToken, controller.signal)
    .catch((error) => {
      console.error(`[generation] Job ${jobId} unhandled error:`, error);
    })
    .finally(() => {
      clearTimeout(timeout);
      activeJobs.delete(jobId);
      processNextInQueue();
    });
}

/**
 * Process next job in queue when a slot opens
 */
function processNextInQueue(): void {
  if (jobQueue.length === 0 || activeJobs.size >= config.maxConcurrentJobs) {
    return;
  }

  const next = jobQueue.shift()!;
  console.log(`[generation] Dequeuing job ${next.jobId} (${jobQueue.length} remaining in queue)`);
  runJob(next.jobId, next.userToken);
}

/**
 * Execute the full generation pipeline for a job
 */
async function executeJob(jobId: string, userToken: string, signal: AbortSignal): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `ai-gen-${jobId}`);

  try {
    // Fetch job from DB
    const job = await getGeneration(jobId);
    if (!job) {
      console.error(`[generation] Job ${jobId} not found in database`);
      return;
    }

    // Create temp directory for this job
    fs.mkdirSync(tmpDir, { recursive: true });

    // Phase 1: Generate website with Claude
    await updateGenerationStatus(jobId, 'generating', 'Generating website with AI...');
    console.log(`[generation] Job ${jobId}: calling Claude API`);

    const assets = (job.assets || []).map((a: any) => ({
      fileName: a.fileName,
      type: a.type,
      url: a.url || a.gatewayUrl || '',
      content: a.content || a.parsedContent || '',
    }));

    const files = await generateWebsite(job.prompt, assets, {
      signal,
      tmpDir,
      pipelineVersion: job.pipeline_version ?? undefined,
      onProgress: (message) =>
        updateGenerationStatus(jobId, 'generating', message),
    });

    if (signal.aborted) {
      throw new Error('Generation timed out');
    }

    // Validate generated files before writing
    if (files.length > 50) {
      throw new Error(`Too many files generated (${files.length}, max 50)`);
    }

    let totalSize = 0;
    for (const file of files) {
      // Path traversal defense: ensure resolved path stays inside tmpDir
      const resolvedPath = path.resolve(tmpDir, file.path);
      if (!resolvedPath.startsWith(tmpDir + path.sep) && resolvedPath !== tmpDir) {
        throw new Error(`Invalid file path rejected: ${file.path}`);
      }

      // Reject suspicious path components
      if (file.path.includes('..') || file.path.startsWith('/')) {
        throw new Error(`Invalid file path rejected: ${file.path}`);
      }

      totalSize += file.content.length;
    }

    // Response size check: 10MB max total
    if (totalSize > 10_000_000) {
      throw new Error(`Generated content too large (${(totalSize / 1_000_000).toFixed(1)}MB, max 10MB)`);
    }

    // Write files to temp directory (for debugging/auditing, not executed)
    for (const file of files) {
      const filePath = path.resolve(tmpDir, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }

    // Phase 2: Publish to IPFS
    await updateGenerationStatus(jobId, 'publishing', 'Publishing website to IPFS...');
    console.log(`[generation] Job ${jobId}: publishing ${files.length} files to IPFS`);

    const { cid, gatewayUrl } = await publishWebsite(
      files,
      jobId,
      userToken,
      { enableTracking: job.enable_tracking === true }
    );

    // Phase 3: Complete
    await completeGeneration(jobId, cid, gatewayUrl);
    console.log(`[generation] Job ${jobId}: completed — CID: ${cid}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[generation] Job ${jobId} failed:`, errorMessage);

    await failGeneration(jobId, errorMessage);

    // Refund credits on failure
    try {
      const job = await getGeneration(jobId);
      if (job && job.credits_charged > 0) {
        const refundUserId = job.user_id || job.user_email;
        const refundResult = await refundCredits(refundUserId, jobId, job.credits_charged);
        if (!refundResult.success) {
          console.error(`[generation] CRITICAL: Refund failed for job ${jobId}, user ${refundUserId.slice(0, 8)}..., amount ${job.credits_charged}: ${refundResult.error}`);
        }
      }
    } catch (refundError) {
      console.error(`[generation] CRITICAL: Refund exception for job ${jobId}:`, refundError);
    }
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Stop all active jobs (for graceful shutdown)
 */
export function stopAllJobs(): void {
  console.log(`[generation] Stopping ${activeJobs.size} active jobs and ${jobQueue.length} queued jobs`);
  jobQueue.length = 0;
  for (const [jobId, controller] of activeJobs) {
    console.log(`[generation] Aborting job ${jobId}`);
    controller.abort();
  }
}
