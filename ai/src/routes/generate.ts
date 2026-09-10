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
  findRevisionBase,
  getGeneration,
  getGenerationsByUser,
  countRecentJobsByUser,
  countFreeCompletedGenerations,
} from '../database/postgres.js';
import {
  getGroupListingRow,
  setListed,
  setListedForGroup,
  setListingDetailsForGroup,
  setListingName,
  setListingUrl,
} from '../database/directory_postgres.js';
import { clearDirectoryCache, isAllowedListingUrl } from './directory.js';
import { deductCredits, refundCredits } from '../services/creditService.js';
import { ensureListingSummary } from '../services/directoryListing.js';
import { startGeneration } from '../services/generationService.js';
import { isNoOpRevision } from '../services/revisionPlan.js';

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
  // ---- Revision ("Recreate") ----
  // The `result_cid` of the site being edited. When present, this job
  // EDITS that site rather than designing a new one. Absent = ordinary
  // from-scratch generation, which is what every older client sends.
  base_cid: z.string().max(200).optional(),
  // What the user asked to change, in their own words. May be empty —
  // an empty change request against an unchanged base is a deliberate
  // "rebuild the same site" and is honored literally (no model call).
  // Bounded well under `prompt` because it rides on every status poll.
  revision_request: z.string().max(8000).optional(),
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

  // Revision: resolve the base BEFORE any credit is taken.
  //
  // A base that cannot be used is refused rather than quietly downgraded
  // to a from-scratch build. Silently designing a brand-new site when the
  // user asked to change an existing one is the exact behaviour this
  // feature exists to end — and it would be charged for.
  let baseGenerationId: string | null = null;
  if (body.base_cid) {
    const base = await findRevisionBase(body.base_cid, userId);
    if (!base) {
      return c.json(
        {
          error: 'The site you are editing could not be found',
          code: 'BASE_NOT_FOUND',
        },
        409
      );
    }
    // Nothing to do: no change request, same settings, same assets — and
    // the same publish flags, so even the bytes would be identical.
    // Answering with the site the user already has is free, instant, and
    // literally correct; running the pipeline could only make it differ.
    //
    // Checked BEFORE the stored-source requirement below, because it does
    // not need the source: a site that predates migration 010 can still
    // answer "nothing changed" from its own published copy. Otherwise
    // every site a user owns today would refuse the one request that is
    // trivially satisfiable.
    if (
      base.resultCid &&
      body.enable_tracking === base.enableTracking &&
      isNoOpRevision({
        basePrompt: base.prompt,
        baseAssets: base.assets,
        newPrompt: body.prompt,
        newAssets: body.assets,
        revisionRequest: body.revision_request,
      })
    ) {
      console.log(
        `[generate] Unchanged revision for user ${userId.slice(0, 8)}... — returning existing site`
      );
      return c.json(
        {
          mode: 'unchanged',
          resultCid: base.resultCid,
          gatewayUrl: base.gatewayUrl,
        },
        200
      );
    }

    if (base.files.length === 0) {
      // A real change was asked for, but this site was generated before
      // the source was kept (or it was over the store cap). The published
      // copy is NOT a substitute: publishing inlines CSS/JS, rewrites
      // asset URLs and injects the analytics script, so editing it would
      // compound those transforms on every pass. The client asks the user
      // whether to design a new site instead.
      return c.json(
        {
          error:
            'This site was created before editing was supported, so its source is not available',
          code: 'BASE_SOURCE_UNAVAILABLE',
        },
        409
      );
    }

    baseGenerationId = base.id;
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
      body.listing_group ?? null,
      baseGenerationId,
      body.revision_request ?? null
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

  console.log(
    `[generate] Job ${jobId} accepted for user ${userId.slice(0, 8)}... (${baseGenerationId ? 'revision' : 'fresh'})`
  );

  // `mode` is echoed so a client that asked to EDIT can tell whether the
  // server understood. zod's object schema is non-strict: a server that
  // predates this feature drops `base_cid` without complaint and would
  // otherwise silently return a redesigned site.
  return c.json(
    { jobId, status: 'accepted', mode: baseGenerationId ? 'revision' : 'fresh' },
    202
  );
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

  // The stable share link. Rejected silently rather than 400: the link
  // is a best-effort enrichment (the IPNS publish may not have landed
  // yet), and failing the whole toggle because of it would be worse
  // than listing with the raw gateway URL.
  let urlAccepted = false;
  let url: string | undefined;
  if (body.url !== undefined) {
    if (isAllowedListingUrl(body.url)) {
      url = body.url;
      urlAccepted = true;
    } else {
      console.warn(
        `[directory] Rejected listing URL for ${id}: not a front-door link`
      );
    }
  }

  // Delegate to the group-wide writers when this build belongs to a
  // website group. Visibility is decided per website, so writing this
  // row alone would leave the group's builds disagreeing — the exact
  // split that let a switched-off site stay in the directory. A row with
  // no group IS its own group, so the single-row writers are correct
  // there and only there.
  if (job.listing_group) {
    const ok = await setListedForGroup(job.listing_group, userId, body.listed);
    if (!ok) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    await setListingDetailsForGroup(job.listing_group, userId, {
      name: body.name,
      url,
    });
  } else {
    const ok = await setListed(id, userId, body.listed);
    if (!ok) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    if (body.name !== undefined) await setListingName(id, body.name);
    if (url !== undefined) await setListingUrl(id, url);
  }

  // The public listing is cached in this process; a toggle the user just
  // made must not sit behind a 60s TTL.
  clearDirectoryCache();

  // First time it goes public, describe + categorise it. Guarded by
  // `listing_generated_at` inside, so off -> on -> off -> on never bills
  // a second AI call. Fire-and-forget: the toggle must not wait on it,
  // and a failure leaves the entry listed without a blurb.
  if (body.listed && job.status === 'completed') {
    void ensureListingSummary(id);
  }

  return c.json({ ok: true, listed: body.listed, urlAccepted });
});

// ============================================
// Website-GROUP listing (what the app actually uses)
// ============================================
//
// GET  /api/v1/websites/:group/listing
// POST /api/v1/websites/:group/listing
//
// Keyed on the website group (its tag id), not a generation id.
// `ai_generations.id` is the server's jobId, which the client only holds
// while a job is in flight and discards on completion — so an id-keyed
// toggle 404s for every finished site, which is exactly what hid the
// switch in the app. The group is stable, is always known to the client,
// and is already what the directory de-duplicates on.

generateRoutes.get('/websites/:group/listing', async (c) => {
  const userId = c.get('userId');
  const row = await getGroupListingRow(c.req.param('group'), userId);
  if (!row) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({
    listed: row.listed === true,
    delistedByAdmin: row.delisted_by_admin === true,
    hasStableUrl: !!row.listing_url,
  });
});

generateRoutes.post('/websites/:group/listing', async (c) => {
  const userId = c.get('userId');
  const group = c.req.param('group');

  let body: z.infer<typeof listingToggleSchema>;
  try {
    body = listingToggleSchema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation error', details: error.errors }, 400);
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const row = await getGroupListingRow(group, userId);
  if (!row) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  if (row.delisted_by_admin && body.listed) {
    return c.json(
      { error: 'This site was removed from the directory', code: 'DELISTED' },
      409
    );
  }

  // Group-wide. Writing only the newest build left older builds listed,
  // so switching listing OFF did not take the site out of the directory
  // — the public query fell through to an older row and the user could
  // not complete the withdrawal. Listing consent is given per website,
  // so it is withdrawn per website too.
  const ok = await setListedForGroup(group, userId, body.listed);
  if (!ok) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  let urlAccepted = false;
  let url: string | undefined;
  if (body.url !== undefined) {
    if (isAllowedListingUrl(body.url)) {
      url = body.url;
      urlAccepted = true;
    } else {
      console.warn(
        `[directory] Rejected listing URL for group ${group}: not a front-door link`
      );
    }
  }
  // The display name and the IPNS front door describe the SITE and are
  // stable across regenerations, so they go on every build — otherwise
  // the entry's link would depend on which build represents it.
  await setListingDetailsForGroup(group, userId, { name: body.name, url });

  // The public listing is cached in this process; a toggle the user just
  // made must not sit behind a 60s TTL.
  clearDirectoryCache();

  if (body.listed) void ensureListingSummary(row.id);

  return c.json({ ok: true, listed: body.listed, urlAccepted });
});

export default generateRoutes;
