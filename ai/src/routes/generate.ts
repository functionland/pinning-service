/**
 * Generation Routes
 *
 * POST /api/v1/generate — Submit new generation job
 * GET  /api/v1/status/:id — Check job status
 * GET  /api/v1/generations — List user's generations
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { jwtValidatorMiddleware } from '../middleware/jwtValidator.js';
import {
  createGeneration,
  getGeneration,
  getGenerationsByUser,
  countRecentJobsByUser,
  countFreeCompletedGenerations,
} from '../database/postgres.js';
import {
  setListed,
  setListingName,
  setListingUrl,
} from '../database/directory_postgres.js';
import { isAllowedListingUrl } from './directory.js';
import { deductCredits, refundCredits } from '../services/creditService.js';
import { ensureListingSummary } from '../services/directoryListing.js';
import { startGeneration } from '../services/generationService.js';

interface Env {
  Variables: {
    userId: string;
    userToken: string;
    requestId: string;
    requestStartTime: number;
  };
}

export const generateRoutes = new Hono<Env>();

// Apply JWT auth to all routes
generateRoutes.use('*', jwtValidatorMiddleware);

// ============================================
// Request Validation
// ============================================

const generateRequestSchema = z.object({
  // 80K chars ≈ 20-27K tokens — a small fraction of the model's 1M-token
  // context. The cap exists to bound abuse, not the API. Note the client
  // sends the ENRICHED prompt (user text + hidden style/language/contact
  // blocks), so this must stay comfortably above the app's input cap.
  prompt: z.string().min(1, 'Prompt is required').max(80000, 'Prompt too long'),
  assets: z
    .array(
      z.object({
        fileName: z.string().max(500),
        type: z.string().max(50),
        url: z.string().max(2000),
        content: z.string().max(100_000, 'Asset content max 100KB').optional(),
      })
    )
    .max(30, 'Max 30 assets allowed')
    .default([]),
  // Opt-in: when true, the IPFS publish step injects the fxfiles-analytics
  // <script> into the generated index.html before pinning. Default off so a
  // missing field from older clients behaves as if tracking is disabled.
  enable_tracking: z.boolean().default(false),
  // Client capability declaration: >=2 opts into the multi-pass pipeline
  // (the client polls for up to 20 minutes). Absent = legacy client → the
  // faster single-pass pipeline that fits the old 5-minute deadline.
  pipeline_version: z.number().int().min(1).max(10).optional(),
  // Public directory ("yellow pages") opt-in, false unless the user
  // deliberately asked for it. Defaulting FALSE here also means an older
  // client that never heard of the directory cannot publish a user into
  // it by omission.
  listed: z.boolean().default(false),
  // The website group's display name, sent explicitly rather than
  // scraped out of `prompt` (which is free text the user wrote and may
  // contain personal detail).
  listing_name: z.string().max(200).optional(),
  // Opaque per-website key (the client's tag id) so the directory shows
  // ONE entry per website rather than one per regeneration.
  listing_group: z.string().max(200).optional(),
});

// ============================================
// POST /api/v1/generate
// ============================================

generateRoutes.post('/generate', async (c) => {
  const userId = c.get('userId');

  // Parse and validate request body
  let body: z.infer<typeof generateRequestSchema>;
  try {
    const raw = await c.req.json();
    body = generateRequestSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        { error: 'Validation error', details: error.errors },
        400
      );
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Rate limit check
  const recentCount = await countRecentJobsByUser(userId, 1);
  if (recentCount >= config.maxJobsPerUserPerHour) {
    return c.json(
      {
        error: `Rate limit exceeded. Max ${config.maxJobsPerUserPerHour} generations per hour.`,
        code: 'RATE_LIMIT',
      },
      429
    );
  }

  // Generate job ID
  const jobId = uuidv4();

  // Pricing — depends on whether the request opts into click-tracking.
  // Computed once and used for deduction, refund, response.required, and
  // the persisted creditsCharged so the audit row matches what was taken.
  const effectiveCost = body.enable_tracking
    ? config.generationCostFulaWithTracking
    : config.generationCostFula;

  // Free tier check: skip credit deduction if user has unused free generations
  const freeCompletedCount = await countFreeCompletedGenerations(userId);
  const isFreeGeneration = freeCompletedCount < config.freeGenerationsPerUser;

  if (isFreeGeneration) {
    console.log(`[generate] Free generation for user ${userId.slice(0, 8)}... (${freeCompletedCount}/${config.freeGenerationsPerUser} used)`);
  }

  // Deduct credits atomically — skip for free generations
  if (!isFreeGeneration) {
    const deduction = await deductCredits(userId, jobId, effectiveCost);
    if (!deduction.success) {
      if (deduction.insufficientBalance) {
        return c.json(
          {
            error: 'Insufficient credits',
            code: 'INSUFFICIENT_CREDITS',
            required: effectiveCost,
            balance: deduction.newBalance ?? 0,
          },
          402
        );
      }
      return c.json(
        {
          error: 'Credit deduction failed',
          code: 'CREDIT_ERROR',
          details: deduction.error,
        },
        500
      );
    }
  }

  const creditsCharged = isFreeGeneration ? 0 : effectiveCost;

  // Create DB record + queue job — if anything fails, refund credits
  try {
    await createGeneration(
      jobId,
      userId,
      body.prompt,
      body.assets,
      creditsCharged,
      body.enable_tracking,
      body.pipeline_version ?? null,
      body.listed,
      body.listing_name ?? null,
      body.listing_group ?? null
    );

    // Queue the job (pass user token for S3 uploads)
    startGeneration(jobId, c.get('userToken'));
  } catch (error) {
    // DB insert or queue failed — refund the credits we just deducted
    if (!isFreeGeneration) {
      console.error(`[generate] Job ${jobId} setup failed, refunding credits:`, error);
      try {
        await refundCredits(userId, jobId, effectiveCost);
      } catch (refundError) {
        // Log loudly — this means credits are lost and need manual recovery
        console.error(`[generate] CRITICAL: Refund failed for job ${jobId}, user ${userId.slice(0, 8)}..., amount ${effectiveCost}:`, refundError);
      }
    } else {
      console.error(`[generate] Job ${jobId} setup failed (free generation):`, error);
    }
    return c.json(
      { error: 'Failed to create generation job', code: 'INTERNAL_ERROR' },
      500
    );
  }

  console.log(`[generate] Job ${jobId} accepted for user ${userId.slice(0, 8)}...`);

  return c.json({ jobId, status: 'accepted' }, 202);
});

// ============================================
// GET /api/v1/status/:id
// ============================================

generateRoutes.get('/status/:id', async (c) => {
  const userId = c.get('userId');
  const jobId = c.req.param('id');

  const job = await getGeneration(jobId);

  if (!job || (job.user_id !== userId && job.user_email !== userId)) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({
    id: job.id,
    status: job.status,
    statusMessage: job.status_message,
    resultCid: job.result_cid,
    gatewayUrl: job.gateway_url,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    // Public directory state, so the owner's toggle can render what is
    // actually true rather than what this browser last sent.
    listed: job.listed === true,
    listingCategory: job.listing_category,
    listingDescription: job.listing_description,
    delistedByAdmin: job.delisted_by_admin === true,
  });
});

// ============================================
// GET /api/v1/generations
// ============================================

generateRoutes.get('/generations', async (c) => {
  const userId = c.get('userId');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);

  const { generations, total } = await getGenerationsByUser(userId, page, limit);

  return c.json({
    generations: generations.map((g) => ({
      id: g.id,
      status: g.status,
      statusMessage: g.status_message,
      resultCid: g.result_cid,
      gatewayUrl: g.gateway_url,
      errorMessage: g.error_message,
      prompt: g.prompt.slice(0, 200),
      creditsCharged: g.credits_charged,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      completedAt: g.completed_at,
    })),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
});

// ============================================
// POST /api/v1/generations/:id/listing
// ============================================

const listingToggleSchema = z.object({
  listed: z.boolean(),
  /** Optional rename of the directory entry (the group's display name). */
  name: z.string().max(200).optional(),
  /**
   * The group's stable IPNS front door (https://fxfiles.top/w/<k51…>).
   * Only the client knows it — the pointer lives in the user's own
   * encrypted manifest — so it is sent here and VALIDATED before
   * storage. A rejected URL is dropped and the entry keeps its raw
   * per-generation gateway link.
   */
  url: z.string().max(500).optional(),
});

/**
 * Turn a finished website's public-directory listing on or off.
 *
 * Lives on THIS router because it already carries the JWT middleware and
 * the same ownership rule as `GET /status/:id`. Being able to change it
 * after the fact is the point: a user must not have to regenerate a site
 * to take it out of the directory.
 *
 * POST rather than PATCH so the browser preflight stays inside the CORS
 * method list the service already publishes.
 */
generateRoutes.post('/generations/:id/listing', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  let body: z.infer<typeof listingToggleSchema>;
  try {
    body = listingToggleSchema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation error', details: error.errors }, 400);
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const job = await getGeneration(id);
  if (!job || (job.user_id !== userId && job.user_email !== userId)) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  // An admin delisting is not something the owner can undo by toggling.
  if (job.delisted_by_admin && body.listed) {
    return c.json(
      { error: 'This site was removed from the directory', code: 'DELISTED' },
      409
    );
  }

  const ok = await setListed(id, userId, body.listed);
  if (!ok) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  if (body.name !== undefined) await setListingName(id, body.name);

  // The stable share link. Rejected silently rather than 400: the link
  // is a best-effort enrichment (the IPNS publish may not have landed
  // yet), and failing the whole toggle because of it would be worse
  // than listing with the raw gateway URL.
  let urlAccepted = false;
  if (body.url !== undefined) {
    if (isAllowedListingUrl(body.url)) {
      await setListingUrl(id, body.url);
      urlAccepted = true;
    } else {
      console.warn(
        `[directory] Rejected listing URL for ${id}: not a front-door link`
      );
    }
  }

  // First time it goes public, describe + categorise it. Guarded by
  // `listing_generated_at` inside, so off -> on -> off -> on never bills
  // a second AI call. Fire-and-forget: the toggle must not wait on it,
  // and a failure leaves the entry listed without a blurb.
  if (body.listed && job.status === 'completed') {
    void ensureListingSummary(id);
  }

  return c.json({ ok: true, listed: body.listed, urlAccepted });
});

export default generateRoutes;
