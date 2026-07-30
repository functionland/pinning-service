/**
 * Generic in-memory job pool.
 *
 * Extracted from the generationService pattern (active map + FIFO queue +
 * per-job AbortController + hard timeout) so a second job type gets its own
 * isolated pool without touching the website-generation one. Same known
 * limitation as the original: process-local — queued/active jobs are lost on
 * restart (the social boot reaper compensates on the DB side).
 */

export interface JobPoolOptions {
  /** Log tag, e.g. 'social'. */
  name: string;
  maxConcurrent: number;
  timeoutMs: number;
  /** The job body. MUST NOT throw unhandled — but if it does, the pool logs
   *  and moves on (mirror of generationService's runJob catch). */
  execute: (jobId: string, userToken: string, signal: AbortSignal) => Promise<void>;
}

export interface JobPool {
  start(jobId: string, userToken: string): void;
  activeCount(): number;
  queuedCount(): number;
  stopAll(): void;
}

export function createJobPool(opts: JobPoolOptions): JobPool {
  const { name, maxConcurrent, timeoutMs, execute } = opts;
  const activeJobs = new Map<string, AbortController>();
  const jobQueue: Array<{ jobId: string; userToken: string }> = [];

  function runJob(jobId: string, userToken: string): void {
    const controller = new AbortController();
    activeJobs.set(jobId, controller);

    const timeout = setTimeout(() => {
      console.warn(`[${name}] Job ${jobId} timed out after ${timeoutMs}ms`);
      controller.abort();
    }, timeoutMs);

    execute(jobId, userToken, controller.signal)
      .catch((error) => {
        console.error(`[${name}] Job ${jobId} unhandled error:`, error);
      })
      .finally(() => {
        clearTimeout(timeout);
        activeJobs.delete(jobId);
        processNextInQueue();
      });
  }

  function processNextInQueue(): void {
    if (jobQueue.length === 0 || activeJobs.size >= maxConcurrent) {
      return;
    }
    const next = jobQueue.shift()!;
    console.log(`[${name}] Dequeuing job ${next.jobId} (${jobQueue.length} remaining in queue)`);
    runJob(next.jobId, next.userToken);
  }

  return {
    start(jobId: string, userToken: string): void {
      if (activeJobs.size >= maxConcurrent) {
        console.log(`[${name}] Job ${jobId} queued (${activeJobs.size}/${maxConcurrent} active)`);
        jobQueue.push({ jobId, userToken });
        return;
      }
      runJob(jobId, userToken);
    },
    activeCount: () => activeJobs.size,
    queuedCount: () => jobQueue.length,
    stopAll(): void {
      console.log(`[${name}] Stopping ${activeJobs.size} active and ${jobQueue.length} queued jobs`);
      jobQueue.length = 0;
      for (const [jobId, controller] of activeJobs) {
        console.log(`[${name}] Aborting job ${jobId}`);
        controller.abort();
      }
    },
  };
}
