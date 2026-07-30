/**
 * Social Post Routes
 *
 * POST /api/v1/social/generate        — submit a social-post job (JWT)
 * GET  /api/v1/social/status/:id      — poll job status (JWT)
 * POST /api/v1/social/buffer/channels — list the user's Buffer channels (JWT)
 * POST /api/v1/social/buffer/post     — queue posts to Buffer channels (JWT)
 * GET  /api/v1/social/image/:cid      — PUBLIC MIME passthrough for social
 *                                       images (bare-CID gateway responses
 *                                       are text/plain + nosniff, which
 *                                       Buffer's server-side fetch may reject)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { jwtValidatorMiddleware } from '../middleware/jwtValidator.js';
import {
  createSocialPost,
  getSocialPost,
  findSocialPostByIdempotency,
  countRecentSocialJobsByUser,
  failSocialPost,
  socialPostExistsByImageCid,
} from '../database/social_postgres.js';
import { deductCredits, refundCredits } from '../services/creditService.js';
import { startSocialJob } from '../services/socialService.js';
import { fetchBufferChannels, createBufferPosts } from '../services/bufferService.js';

interface Env {
  Variables: {
    userId: string;
    userToken: string;
    requestId: string;
    requestStartTime: number;
  };
}

// ============================================
// Public routes (no auth) — image passthrough
// ============================================

export const socialPublicRoutes = new Hono();

const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{40,90})$/;
const PASSTHROUGH_MAX_BYTES = 15 * 1024 * 1024;
const PASSTHROUGH_TIMEOUT_MS = 30_000;
/** JPEG magic bytes — the social pipeline only ever uploads sharp-encoded
 *  JPEGs, so anything else behind a requested CID is not ours to serve. */
function looksLikeJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Read the body with a HARD byte cap enforced WHILE streaming — a chunked
 *  upstream response must never buffer past the cap before rejection. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

socialPublicRoutes.get('/image/:cid', async (c) => {
  const cid = c.req.param('cid');
  if (!CID_PATTERN.test(cid)) {
    return c.json({ error: 'Invalid CID' }, 400);
  }

  // Only CIDs this feature generated are served — the endpoint is not a
  // general relay for arbitrary public IPFS objects.
  const known = await socialPostExistsByImageCid(cid);
  if (!known) {
    return c.json({ error: 'Not Found', code: 'NOT_FOUND' }, 404);
  }

  const gatewayBase = config.ipfsGatewayUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PASSTHROUGH_TIMEOUT_MS);
  try {
    // Fixed upstream host + path-segment-only interpolation + no redirect
    // following: this cannot be steered to another origin.
    const res = await fetch(`${gatewayBase}/${cid}`, {
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      return c.json({ error: 'Upstream redirect refused' }, 502);
    }
    if (res.status === 404 || res.status === 410) {
      return c.json({ error: 'Not Found', code: 'NOT_FOUND' }, 404);
    }
    if (!res.ok) {
      return c.json({ error: 'Upstream error' }, 502);
    }
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && parseInt(lenHeader, 10) > PASSTHROUGH_MAX_BYTES) {
      return c.json({ error: 'Object too large' }, 413);
    }
    const buf = await readCapped(res, PASSTHROUGH_MAX_BYTES);
    if (buf === null) {
      return c.json({ error: 'Object too large' }, 413);
    }
    if (!looksLikeJpeg(buf)) {
      return c.json({ error: 'Not a social image' }, 415);
    }
    // Immutable by construction: a CID's bytes can never change.
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(buf.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return c.json({ error: 'Upstream timeout' }, 504);
    }
    return c.json({ error: 'Upstream error' }, 502);
  } finally {
    clearTimeout(timeout);
  }
});

// ============================================
// Authed routes
// ============================================

export const socialRoutes = new Hono<Env>();

socialRoutes.use('*', jwtValidatorMiddleware);

// --------------------------------------------
// In-memory per-user rate limiter for the Buffer proxy (30/min channels,
// 10/min post). Process-local, same posture as the app's IP blocklist.
// --------------------------------------------
const bufferCallTimes = new Map<string, number[]>();
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, times] of bufferCallTimes) {
    const kept = times.filter((t) => t > cutoff);
    if (kept.length === 0) bufferCallTimes.delete(key);
    else bufferCallTimes.set(key, kept);
  }
}, 10 * 60 * 1000).unref();

function bufferRateLimited(userId: string, kind: 'channels' | 'post'): boolean {
  const limit = kind === 'channels' ? 30 : 10;
  const key = `${kind}:${userId}`;
  const cutoff = Date.now() - 60_000;
  const times = (bufferCallTimes.get(key) || []).filter((t) => t > cutoff);
  if (times.length >= limit) {
    bufferCallTimes.set(key, times);
    return true;
  }
  times.push(Date.now());
  bufferCallTimes.set(key, times);
  return false;
}

// ============================================
// Request Validation
// ============================================

const httpUrl = (max: number) =>
  z
    .string()
    .url()
    .max(max)
    .refine((u) => u.startsWith('https://') || u.startsWith('http://'), {
      message: 'must be an http(s) URL',
    });

const socialGenerateSchema = z.object({
  generationId: z.string().min(1).max(200),
  websiteUrl: httpUrl(2000),
  prompt: z.string().min(1).max(20000),
  assets: z
    .array(
      z.object({
        fileName: z.string().max(500),
        type: z.string().max(50),
        url: httpUrl(2000),
      })
    )
    .max(14)
    .default([]),
  assetPrefix: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/)
    .refine((p) => p !== '.' && p !== '..', { message: 'invalid prefix' }),
});

const bufferChannelsSchema = z.object({
  bufferToken: z.string().min(1).max(4096),
});

const bufferPostSchema = z.object({
  bufferToken: z.string().min(1).max(4096),
  channelIds: z.array(z.string().min(1).max(200)).min(1).max(10),
  text: z.string().min(1).max(5000),
  imageUrl: httpUrl(2000),
});

/** Status/buffer responses prefer the MIME passthrough URL when configured. */
function socialImagePublicUrl(cid: string, rawUrl: string): string {
  if (!config.socialPublicBaseUrl) {
    return rawUrl;
  }
  const base = config.socialPublicBaseUrl.replace(/\/+$/, '');
  return `${base}/api/v1/social/image/${cid}`;
}

/** The Buffer proxy only relays images we host — not arbitrary URLs. */
function isOwnImageUrl(imageUrl: string): boolean {
  try {
    const host = new URL(imageUrl).host;
    const allowed = new Set<string>();
    try {
      allowed.add(new URL(config.ipfsGatewayUrl).host);
    } catch { /* unset */ }
    if (config.socialPublicBaseUrl) {
      try {
        allowed.add(new URL(config.socialPublicBaseUrl).host);
      } catch { /* invalid */ }
    }
    return allowed.has(host);
  } catch {
    return false;
  }
}

// ============================================
// POST /api/v1/social/generate
// ============================================

socialRoutes.post('/generate', async (c) => {
  const userId = c.get('userId');

  if (!config.geminiApiKey) {
    return c.json(
      { error: 'Social post generation is not enabled on this server', code: 'SOCIAL_DISABLED' },
      503
    );
  }

  let body: z.infer<typeof socialGenerateSchema>;
  try {
    body = socialGenerateSchema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation error', details: error.errors }, 400);
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Idempotency replay BEFORE any billing or rate accounting.
  const idempotencyKey = c.req.header('Idempotency-Key')?.slice(0, 200) || null;
  if (idempotencyKey) {
    const existing = await findSocialPostByIdempotency(userId, idempotencyKey);
    if (existing) {
      return c.json({ jobId: existing.id, status: 'accepted' }, 202);
    }
  }

  const recentCount = await countRecentSocialJobsByUser(userId, 1);
  if (recentCount >= config.maxSocialJobsPerUserPerHour) {
    return c.json(
      {
        error: `Rate limit exceeded. Max ${config.maxSocialJobsPerUserPerHour} social posts per hour.`,
        code: 'RATE_LIMIT',
      },
      429
    );
  }

  const jobId = uuidv4();
  const cost = config.socialPostPriceFula;

  const deduction = await deductCredits(userId, jobId, cost);
  if (!deduction.success) {
    if (deduction.insufficientBalance) {
      return c.json(
        {
          error: 'Insufficient credits',
          code: 'INSUFFICIENT_CREDITS',
          required: cost,
          balance: deduction.newBalance ?? 0,
        },
        402
      );
    }
    return c.json(
      { error: 'Credit deduction failed', code: 'CREDIT_ERROR', details: deduction.error },
      500
    );
  }

  const refundThisRequest = async (reason: string) => {
    console.error(`[social] Job ${jobId} setup failed (${reason}), refunding credits`);
    try {
      // refundCredits reports failure via {success:false}, not by throwing —
      // both paths must produce the CRITICAL manual-recovery log.
      const result = await refundCredits(userId, jobId, cost);
      if (!result.success) {
        console.error(
          `[social] CRITICAL: Refund failed for job ${jobId}, user ${userId.slice(0, 8)}..., amount ${cost}: ${result.error}`
        );
      }
    } catch (refundError) {
      console.error(
        `[social] CRITICAL: Refund exception for job ${jobId}, user ${userId.slice(0, 8)}..., amount ${cost}:`,
        refundError
      );
    }
  };

  try {
    await createSocialPost({
      id: jobId,
      userId,
      generationId: body.generationId,
      prompt: body.prompt,
      websiteUrl: body.websiteUrl,
      assetPrefix: body.assetPrefix,
      assets: body.assets,
      creditsCharged: cost,
      idempotencyKey,
    });
  } catch (error: any) {
    // Unique-violation on (user_id, idempotency_key): a concurrent identical
    // request won the insert — refund OUR deduction and replay the winner.
    if (error?.code === '23505' && idempotencyKey) {
      await refundThisRequest('idempotency race');
      const existing = await findSocialPostByIdempotency(userId, idempotencyKey);
      if (existing) {
        return c.json({ jobId: existing.id, status: 'accepted' }, 202);
      }
    } else {
      await refundThisRequest('db insert failed');
    }
    return c.json({ error: 'Failed to create social post job', code: 'INTERNAL_ERROR' }, 500);
  }

  const started = startSocialJob(jobId, c.get('userToken'));
  if (!started) {
    // Queue saturated — terminalize the row and refund rather than accepting
    // work we can't run.
    await failSocialPost(jobId, 'Service is at capacity, please try again later');
    await refundThisRequest('queue saturated');
    return c.json({ error: 'Service busy, try again later', code: 'BUSY' }, 503);
  }

  console.log(`[social] Job ${jobId} accepted for user ${userId.slice(0, 8)}...`);
  return c.json({ jobId, status: 'accepted' }, 202);
});

// ============================================
// GET /api/v1/social/status/:id
// ============================================

socialRoutes.get('/status/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const job = await getSocialPost(id);
  // 404 (not 403) on foreign rows — no existence leak.
  if (!job || job.user_id !== userId) {
    return c.json({ error: 'Not Found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({
    id: job.id,
    status: job.status,
    statusMessage: job.status_message,
    image:
      job.image_cid && job.image_url
        ? { cid: job.image_cid, url: socialImagePublicUrl(job.image_cid, job.image_url) }
        : null,
    captions: job.captions ?? null,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });
});

// ============================================
// POST /api/v1/social/buffer/channels
// ============================================

socialRoutes.post('/buffer/channels', async (c) => {
  const userId = c.get('userId');
  if (bufferRateLimited(userId, 'channels')) {
    return c.json({ error: 'Rate limit exceeded', code: 'RATE_LIMIT' }, 429);
  }

  let body: z.infer<typeof bufferChannelsSchema>;
  try {
    body = bufferChannelsSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'Validation error' }, 400);
  }

  try {
    const channels = await fetchBufferChannels(body.bufferToken);
    return c.json({ channels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Buffer request failed';
    const auth = msg.includes('invalid or expired');
    return c.json({ error: msg, code: auth ? 'BUFFER_AUTH' : 'BUFFER_ERROR' }, auth ? 401 : 502);
  }
});

// ============================================
// POST /api/v1/social/buffer/post
// ============================================

socialRoutes.post('/buffer/post', async (c) => {
  const userId = c.get('userId');
  if (bufferRateLimited(userId, 'post')) {
    return c.json({ error: 'Rate limit exceeded', code: 'RATE_LIMIT' }, 429);
  }

  let body: z.infer<typeof bufferPostSchema>;
  try {
    body = bufferPostSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'Validation error' }, 400);
  }

  if (!isOwnImageUrl(body.imageUrl)) {
    return c.json(
      { error: 'imageUrl must be a generated social image hosted by this service' },
      400
    );
  }

  try {
    const results = await createBufferPosts(
      body.bufferToken,
      body.channelIds,
      body.text,
      body.imageUrl
    );
    return c.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Buffer request failed';
    const auth = msg.includes('invalid or expired');
    return c.json({ error: msg, code: auth ? 'BUFFER_AUTH' : 'BUFFER_ERROR' }, auth ? 401 : 502);
  }
});

export default socialRoutes;
