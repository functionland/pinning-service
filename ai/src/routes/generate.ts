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
import { deductCredits, refundCredits } from '../services/creditService.js';
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
  prompt: z.string().min(1, 'Prompt is required').max(10000, 'Prompt too long'),
  assets: z
    .array(
      z.object({
        fileName: z.string().max(500),
        type: z.string().max(50),
        url: z.string().max(2000),
        content: z.string().max(100_000, 'Asset content max 100KB').optional(),
      })
    )
    .max(10, 'Max 10 assets allowed')
    .default([]),
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

  // Free tier check: skip credit deduction if user has unused free generations
  const freeCompletedCount = await countFreeCompletedGenerations(userId);
  const isFreeGeneration = freeCompletedCount < config.freeGenerationsPerUser;

  if (isFreeGeneration) {
    console.log(`[generate] Free generation for user ${userId.slice(0, 8)}... (${freeCompletedCount}/${config.freeGenerationsPerUser} used)`);
  }

  // Deduct credits atomically — skip for free generations
  if (!isFreeGeneration) {
    const deduction = await deductCredits(userId, jobId, config.generationCostFula);
    if (!deduction.success) {
      if (deduction.insufficientBalance) {
        return c.json(
          {
            error: 'Insufficient credits',
            code: 'INSUFFICIENT_CREDITS',
            required: config.generationCostFula,
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

  const creditsCharged = isFreeGeneration ? 0 : config.generationCostFula;

  // Create DB record + queue job — if anything fails, refund credits
  try {
    await createGeneration(
      jobId,
      userId,
      body.prompt,
      body.assets,
      creditsCharged
    );

    // Queue the job (pass user token for S3 uploads)
    startGeneration(jobId, c.get('userToken'));
  } catch (error) {
    // DB insert or queue failed — refund the credits we just deducted
    if (!isFreeGeneration) {
      console.error(`[generate] Job ${jobId} setup failed, refunding credits:`, error);
      try {
        await refundCredits(userId, jobId, config.generationCostFula);
      } catch (refundError) {
        // Log loudly — this means credits are lost and need manual recovery
        console.error(`[generate] CRITICAL: Refund failed for job ${jobId}, user ${userId.slice(0, 8)}..., amount ${config.generationCostFula}:`, refundError);
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

export default generateRoutes;
