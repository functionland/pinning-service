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
  getRevisionBaseById,
  updateGenerationStatus,
  completeGeneration,
  failGeneration,
  saveGenerationFiles,
} from '../database/postgres.js';
import { generateWebsite, reviseWebsite } from './claudeService.js';
import { describeSettingsDelta, isNoOpRevision } from './revisionPlan.js';
import { ensureListingSummary } from './directoryListing.js';
import { publishWebsite } from './ipfsService.js';
import { refundCredits } from './creditService.js';

// Active jobs tracker
const activeJobs = new Map<string, AbortController>();
const jobQueue: Array<{ jobId: string; userToken: string }> = [];

/**
 * Cap on the source we keep for a later revision. Typical generated sites
 * are 50-300KB; this leaves generous room while keeping one pathological
 * job from parking megabytes in Postgres. Over the cap the row is simply
 * not written — revision then falls back to the published copy, which is
 * the same path legacy generations take.
 */
const MAX_STORED_SOURCE_BYTES = 2_000_000;

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

    const assets = (job.assets || []).map((a: any) => ({
      fileName: a.fileName,
      type: a.type,
      url: a.url || a.gatewayUrl || '',
      content: a.content || a.parsedContent || '',
    }));

    // A job with a base EDITS that site. The base was resolved and
    // ownership-checked when the request was accepted; this only loads it.
    const base = job.base_generation_id
      ? await getRevisionBaseById(job.base_generation_id)
      : null;

    let files: Array<{ path: string; content: string }>;
    if (base && base.files.length > 0) {
      const noOp = isNoOpRevision({
        basePrompt: base.prompt,
        baseAssets: base.assets,
        newPrompt: job.prompt,
        newAssets: job.assets || [],
        revisionRequest: job.revision_request,
      });

      if (noOp) {
        // Nothing was asked for. Republishing the stored source is the
        // only way to return the SAME site — a model call, however well
        // instructed, cannot promise byte-identical output. The publish
        // step still runs, so a changed tracking setting is applied.
        console.log(`[generation] Job ${jobId}: no-op revision — republishing source`);
        await updateGenerationStatus(jobId, 'generating', 'Rebuilding the same site...');
        files = base.files;
      } else {
        console.log(`[generation] Job ${jobId}: revising ${base.id}`);
        files = await reviseWebsite(job.prompt, assets, {
          signal,
          tmpDir,
          baseFiles: base.files,
          revisionRequest: job.revision_request ?? '',
          settingsDelta: describeSettingsDelta(base.prompt, job.prompt),
          onProgress: (message) =>
            updateGenerationStatus(jobId, 'generating', message),
        });
      }
    } else {
      if (job.base_generation_id) {
        // Accepted as a revision but the source is gone (pruned, or over
        // the store cap). Failing is the honest answer: the alternative
        // is charging for the surprise redesign this feature exists to
        // prevent.
        throw new Error(
          'The source of the site you are editing is no longer available. Create a new website instead.'
        );
      }
      console.log(`[generation] Job ${jobId}: calling Claude API`);
      files = await generateWebsite(job.prompt, assets, {
        signal,
        tmpDir,
        pipelineVersion: job.pipeline_version ?? undefined,
        onProgress: (message) =>
          updateGenerationStatus(jobId, 'generating', message),
      });
    }

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

    // Keep the RAW files (what the model wrote, not what publish rewrote)
    // so a later "Recreate" can edit this site instead of inventing a new
    // one. Written before the row flips to 'completed' so the source is
    // durable by the time the client can ask to revise it. Best-effort:
    // losing it costs a fallback, never the generation.
    if (totalSize <= MAX_STORED_SOURCE_BYTES) {
      try {
        await saveGenerationFiles(jobId, files);
      } catch (err) {
        console.warn(
          `[generation] Job ${jobId}: could not store source for revision: ${(err as Error).message}`
        );
      }
    } else {
      console.warn(
        `[generation] Job ${jobId}: source ${totalSize}B over the ${MAX_STORED_SOURCE_BYTES}B store cap — revision will fall back to the published copy`
      );
    }

    // Phase 3: Complete
    await completeGeneration(jobId, cid, gatewayUrl);
    console.log(`[generation] Job ${jobId}: completed — CID: ${cid}`);

    // Public directory: describe + categorise, but ONLY for a site the
    // user chose to list. Done here because the generated index.html is
    // still in memory, so the common path costs no gateway fetch. Awaited
    // (not fire-and-forget) so the entry has its blurb by the time the
    // client sees 'completed', but it can never fail the generation —
    // ensureListingSummary swallows its own errors.
    if (job.listed === true) {
      const indexHtml = files.find((f) => f.path === 'index.html')?.content;
      await ensureListingSummary(jobId, { html: indexHtml, signal });
    }
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
