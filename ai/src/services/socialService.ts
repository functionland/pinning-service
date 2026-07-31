/**
 * Social post job orchestrator.
 *
 * Owns the social job pool (isolated from website generation so neither
 * starves the other), the pipeline (captions ∥ image → sharp 4:5 → upload),
 * the boot reaper, and refund discipline. Security posture per review:
 * reference images are fetched ONLY from our own gateway hosts over HTTPS
 * (the client only ever sends gateway URLs), and terminal DB transitions are
 * conditional so refunds happen at most once.
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { config } from '../config/index.js';
import {
  getSocialPost,
  updateSocialPostStatus,
  completeSocialPost,
  failSocialPost,
  reapStaleSocialPosts,
} from '../database/social_postgres.js';
import { refundCredits } from './creditService.js';
import { createJobPool } from './jobPool.js';
import { generateSocialCaptions } from './socialCaptions.js';
import { generateSocialImage, type ReferenceImage } from './geminiService.js';
import { uploadSocialImage } from './ipfsService.js';
import { fetchToFile } from '../utils/fetchFile.js';
import { isValidCid } from '../utils/cid.js';
import { buildImagePrompt } from '../prompts/socialPrompts.js';

/** Per-reference-image download cap. Website display assets are ≤25MB by the
 *  client's own rules; 15MB bounds worst-case memory (≤8 × 15MB buffered). */
const REF_FETCH_MAX_BYTES = 15 * 1024 * 1024;
/** Long-edge ceiling for the copy sent to Gemini. */
const REF_MAX_DIM = 1536;
/** Raster image extensions accepted as references (no SVG — script-capable). */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/** Backstop against unbounded queue growth (each entry is tiny, but a queue
 *  this deep means the service is far behind — shed load instead). */
const MAX_QUEUED_SOCIAL_JOBS = 100;

export interface SocialAsset {
  fileName: string;
  type: string;
  url: string;
  /** Content address of the asset. Preferred over `url` — see [refFetchUrl]. */
  cid?: string;
}

/**
 * Hosts a reference image may be fetched from when we have to fall back to
 * the client's URL: our own gateways plus anything in
 * SOCIAL_REF_ALLOWED_HOSTS. An entry beginning with '.' matches subdomains
 * (".dweb.link" covers "<cid>.ipfs.dweb.link"), which is how subdomain-style
 * IPFS gateways address content.
 */
function allowedRefHostRules(): string[] {
  const rules: string[] = [];
  for (const raw of [config.ipfsGatewayUrl, config.s3GatewayUrl]) {
    try {
      rules.push(new URL(raw).host.toLowerCase());
    } catch {
      /* unset/invalid config entry — skip */
    }
  }
  for (const entry of config.socialRefAllowedHosts.split(',')) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed) rules.push(trimmed);
  }
  return rules;
}

export function isAllowedRefUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.host.toLowerCase();
    return allowedRefHostRules().some((rule) =>
      rule.startsWith('.') ? host.endsWith(rule) : host === rule,
    );
  } catch {
    return false;
  }
}

/**
 * Where to actually fetch a reference image from.
 *
 * Prefer a URL WE build from the asset's CID against our own configured
 * gateway: content addressing guarantees identical bytes, and it means the
 * fetch target is never client-controlled. The client's own gateway setting
 * is user-configurable (it defaults to a `<cid>.ipfs.dweb.link` subdomain
 * gateway), so matching on its host is both fragile and a needless SSRF
 * surface. The URL path is only a fallback for assets recorded before CIDs
 * were sent.
 */
export function refFetchUrl(asset: SocialAsset): string | null {
  if (isValidCid(asset.cid)) {
    return `${config.ipfsGatewayUrl.replace(/\/+$/, '')}/${asset.cid}`;
  }
  return isAllowedRefUrl(asset.url) ? asset.url : null;
}

/** Download + downscale reference images. Per-image failures are tolerated —
 *  zero refs degrades to text-only generation. */
async function prepareReferenceImages(
  assets: SocialAsset[],
  tmpDir: string,
  signal: AbortSignal,
): Promise<ReferenceImage[]> {
  const images = assets.filter((a) =>
    IMAGE_EXT.has(path.extname(a.fileName || '').toLowerCase()),
  );
  const candidates = images
    .map((a) => ({ asset: a, fetchUrl: refFetchUrl(a) }))
    .filter((c): c is { asset: SocialAsset; fetchUrl: string } =>
      c.fetchUrl !== null,
    )
    .slice(0, config.socialMaxReferenceImages);

  // Logged per-stage: silently generating from zero brand imagery is a
  // quality failure that looks like success, so make the drop-off visible.
  if (candidates.length < images.length || images.length < assets.length) {
    console.warn(
      `[social] Reference images: ${assets.length} sent -> ${images.length} raster -> ${candidates.length} fetchable`,
    );
  }

  const refs: ReferenceImage[] = [];
  for (const [i, { asset, fetchUrl }] of candidates.entries()) {
    if (signal.aborted) break;
    const tmpPath = path.join(tmpDir, `ref-${i}`);
    try {
      await fetchToFile(fetchUrl, tmpPath, signal, {
        maxBytes: REF_FETCH_MAX_BYTES,
        logTag: '[social]',
        // The host allowlist above is only meaningful if a redirect can't
        // escape it.
        redirect: 'manual',
      });
      const jpeg = await sharp(tmpPath)
        .resize({
          width: REF_MAX_DIM,
          height: REF_MAX_DIM,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
      refs.push({ base64: jpeg.toString('base64'), mimeType: 'image/jpeg' });
    } catch (err) {
      console.warn(
        `[social] Reference image skipped (${asset.fileName}): ${(err as Error).message}`,
      );
    }
  }
  return refs;
}

async function executeSocialJob(
  jobId: string,
  userToken: string,
  poolSignal: AbortSignal,
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `ai-social-${jobId}`);
  // Child controller so a failure in either parallel branch can drain the
  // sibling (Promise.all is fail-fast but does not cancel the other branch).
  const child = new AbortController();
  const onPoolAbort = () => child.abort();
  poolSignal.addEventListener('abort', onPoolAbort);
  const signal = child.signal;

  try {
    const job = await getSocialPost(jobId);
    if (!job) {
      console.error(`[social] Job ${jobId} not found in database`);
      return;
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    await updateSocialPostStatus(
      jobId,
      'generating',
      'Writing captions and designing your social image...',
    );

    const assets: SocialAsset[] = (job.assets || []).map((a: any) => ({
      fileName: a.fileName || '',
      type: a.type || '',
      url: a.url || '',
      cid: typeof a.cid === 'string' ? a.cid : undefined,
    }));

    const captionsPromise = generateSocialCaptions(job.prompt, job.website_url, {
      signal,
    });
    const imagePromise = (async () => {
      const refs = await prepareReferenceImages(assets, tmpDir, signal);
      console.log(`[social] Job ${jobId}: ${refs.length} reference images prepared`);
      return generateSocialImage(buildImagePrompt(job.prompt), refs, { signal });
    })();

    let captions: Awaited<typeof captionsPromise>;
    let rawImage: Buffer;
    try {
      [captions, rawImage] = await Promise.all([captionsPromise, imagePromise]);
    } catch (err) {
      // Drain the surviving branch before rethrowing so no orphan API call
      // keeps running (and spending) behind the failure.
      child.abort();
      await Promise.allSettled([captionsPromise, imagePromise]);
      throw err;
    }
    if (poolSignal.aborted) {
      throw new Error('Social post generation timed out');
    }

    // Normalize to exactly 1080×1350 (4:5) JPEG regardless of what the model
    // emitted — this also re-encodes, so nothing model-controlled reaches the
    // bucket byte-for-byte.
    const jpeg = await sharp(rawImage)
      .resize(1080, 1350, { fit: 'cover' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    await updateSocialPostStatus(jobId, 'publishing', 'Uploading image to IPFS...');
    const uploaded = await uploadSocialImage(
      jpeg,
      job.asset_prefix,
      jobId,
      userToken,
      signal,
    );

    const won = await completeSocialPost(jobId, uploaded.cid, uploaded.url, captions);
    if (!won) {
      // Reaper (new process) already terminalized+refunded this row — leave
      // its verdict standing; the uploaded image is an unreferenced orphan.
      console.warn(`[social] Job ${jobId}: completion lost to a concurrent terminal state`);
      return;
    }
    console.log(`[social] Job ${jobId}: completed — CID: ${uploaded.cid}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[social] Job ${jobId} failed:`, errorMessage);

    try {
      const won = await failSocialPost(jobId, errorMessage);
      // Refund ONLY if this call performed the error transition — otherwise
      // the reaper owns (or already did) the refund.
      if (won) {
        const job = await getSocialPost(jobId);
        if (job && job.credits_charged > 0) {
          const refundResult = await refundCredits(job.user_id, jobId, job.credits_charged);
          if (!refundResult.success) {
            console.error(
              `[social] CRITICAL: Refund failed for job ${jobId}, user ${job.user_id.slice(0, 8)}..., amount ${job.credits_charged}: ${refundResult.error}`,
            );
          }
        }
      }
    } catch (refundError) {
      console.error(`[social] CRITICAL: Refund exception for job ${jobId}:`, refundError);
    }
  } finally {
    poolSignal.removeEventListener('abort', onPoolAbort);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

const pool = createJobPool({
  name: 'social',
  maxConcurrent: config.maxConcurrentSocialJobs,
  timeoutMs: config.socialJobTimeoutMs,
  execute: executeSocialJob,
});

/** Returns false when the queue is saturated (caller should shed load). */
export function startSocialJob(jobId: string, userToken: string): boolean {
  if (pool.queuedCount() >= MAX_QUEUED_SOCIAL_JOBS) {
    return false;
  }
  pool.start(jobId, userToken);
  return true;
}

export const getActiveSocialJobCount = () => pool.activeCount();
export const getQueuedSocialJobCount = () => pool.queuedCount();
export const stopAllSocialJobs = () => pool.stopAll();

/**
 * Boot reaper: any non-terminal row at startup is orphaned (the queue is
 * in-memory), so flip it to error and refund. The conditional UPDATE ...
 * RETURNING makes each row's flip exactly-once across repeated boots; a
 * refund that fails after a successful flip is logged CRITICAL (same
 * at-most-once posture as the rest of the service's billing).
 */
export async function reapStaleSocialJobsOnBoot(): Promise<void> {
  try {
    const reaped = await reapStaleSocialPosts();
    if (reaped.length === 0) {
      return;
    }
    console.warn(`[social] Reaping ${reaped.length} stale jobs from a previous run`);
    for (const row of reaped) {
      if (row.credits_charged > 0) {
        try {
          const result = await refundCredits(row.user_id, row.id, row.credits_charged);
          if (!result.success) {
            console.error(
              `[social] CRITICAL: Reaper refund failed for job ${row.id}, user ${row.user_id.slice(0, 8)}..., amount ${row.credits_charged}: ${result.error}`,
            );
          }
        } catch (err) {
          console.error(`[social] CRITICAL: Reaper refund exception for job ${row.id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[social] Boot reaper failed:', err);
  }
}
