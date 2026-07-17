import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jwtValidatorMiddleware } from '../middleware/jwtValidator.js';
import { askAi } from '../services/claudeService.js';
import { deductCredits, refundCredits } from '../services/creditService.js';
import {
  createAskGeneration,
  claimFreeAskGeneration,
  cacheAskResponse,
  getCachedAskResponse,
} from '../database/ask_postgres.js';

interface Env {
  Variables: {
    userId: string;
    userToken: string;
    requestId: string;
    requestStartTime: number;
  };
}

export const askRoutes = new Hono<Env>();

// Apply JWT auth
askRoutes.use('*', jwtValidatorMiddleware);

// Protect against OOM from large uploads
askRoutes.use('/', bodyLimit({
  maxSize: 35 * 1024 * 1024, // 35MB
  onError: (c) => {
    return c.json({ error: 'Payload too large. Maximum size is 35MB' }, 413);
  },
}));

askRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  
  // 1. Idempotency Key check
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400);
  }

  try {
    const cached = await getCachedAskResponse(idempotencyKey);
    if (cached) {
      return c.json({ response: cached, cached: true }, 200);
    }
  } catch (e) {
    console.warn(`[ask] Failed to check cache for key ${idempotencyKey}:`, e);
  }

  // 2. Parse Multipart Body (max 30 files via app logic/headers)
  const body = await c.req.parseBody({ all: true });
  const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : (Array.isArray(body['prompt']) ? body['prompt'][0] : null);
  
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return c.json({ error: 'Prompt is required' }, 400);
  }

  let filesData = body['files'];
  if (!filesData) {
    filesData = [];
  } else if (!Array.isArray(filesData)) {
    filesData = [filesData];
  }
  
  const files: File[] = [];
  for (const item of filesData) {
    if (item instanceof File) {
      files.push(item);
    }
  }
  
  // Validate limits
  if (files.length > 30) {
    return c.json({ error: 'Maximum 30 files allowed' }, 400);
  }
  
  let totalSize = 0;
  for (const f of files) {
    totalSize += f.size;
  }
  if (totalSize > 30 * 1024 * 1024) {
    return c.json({ error: 'Total file size exceeds 30MB' }, 413);
  }

  // 3. ATOMIC Pricing Logic
  let cost = 1500 * files.length;
  let hasFree = false;
  
  try {
    hasFree = await claimFreeAskGeneration(userId);
  } catch (e) {
    console.error(`[ask] Failed to check free tier for user ${userId}:`, e);
    return c.json({ error: 'Failed to verify billing status', code: 'INTERNAL_ERROR' }, 500);
  }

  if (hasFree) {
    const freeFiles = Math.min(files.length, 3);
    const paidFiles = files.length - freeFiles;
    cost = 1500 * paidFiles;
  }
  
  if (cost > 0) {
    // We use deductCredits with idempotencyKey as jobId for tracking
    const deduction = await deductCredits(userId, idempotencyKey, cost);
    if (!deduction.success) {
      if (deduction.insufficientBalance) {
        return c.json({ error: 'Insufficient credits', code: 'INSUFFICIENT_CREDITS', required: cost }, 402);
      }
      return c.json({ error: 'Credit deduction failed', code: 'CREDIT_ERROR' }, 500);
    }
  }
  
  // 4. Write files to temp dir
  const reqUuid = uuidv4();
  const tmpDir = path.join(os.tmpdir(), `ask-${reqUuid}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  
  const localFiles: { fileName: string; localPath: string }[] = [];
  try {
    for (const f of files) {
      const buf = await f.arrayBuffer();
      // crypto random name to avoid path traversal
      const safeName = uuidv4() + path.extname(f.name);
      const localPath = path.join(tmpDir, safeName);
      fs.writeFileSync(localPath, Buffer.from(buf));
      localFiles.push({ fileName: f.name, localPath });
    }
    
    // 5. Ask Claude
    const textResponse = await askAi(prompt, localFiles);
    
    // Save to Cache & Audit table
    await cacheAskResponse(idempotencyKey, textResponse);
    await createAskGeneration(idempotencyKey, userId, files.length, cost, 'success');
    
    return c.json({ response: textResponse }, 200);
  } catch (err) {
    console.error(`[ask] Error during generation for key ${idempotencyKey}:`, err);
    // 6. Refund credits
    if (cost > 0) {
      await refundCredits(userId, idempotencyKey, cost);
    }
    await createAskGeneration(idempotencyKey, userId, files.length, cost, 'error').catch(()=>null);
    
    return c.json({ error: 'Failed to generate response from AI' }, 500);
  } finally {
    // 7. Clean up temp dir immediately
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[ask] Failed to clean up tmp dir ${tmpDir}:`, e);
    }
  }
});
