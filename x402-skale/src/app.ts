/**
 * Hono App Setup
 *
 * Main application configuration with routes and middleware.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { timing } from 'hono/timing';
import { v4 as uuidv4 } from 'uuid';

import type { Env } from './types/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { s3ProxyRoutes } from './routes/s3Proxy.js';

export const app = new Hono<Env>();

// ============================================
// Global Middleware
// ============================================

// Request timing
app.use('*', timing());

// Request logging
app.use('*', logger());

// Security headers
app.use('*', secureHeaders());

// CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
  allowHeaders: [
    'Authorization',
    'Content-Type',
    'Content-Length',
    'X-Fula-TTL',
    'X-TTL-Seconds',
    'Payment-Authorization',
    'X-Payment',
  ],
  exposeHeaders: [
    'X-Payment-Required',
    'X-PAYMENT-RESPONSE',
    'Content-Length',
    'Content-Type',
    'ETag',
  ],
  maxAge: 86400,
}));

// Per-IP rate limiting (generous for AI agents: 600 req/min = 10/sec sustained)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 600;

// Periodic cleanup to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60_000);

app.use('*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else if (entry.count >= RATE_LIMIT_MAX) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  } else {
    entry.count++;
  }
  await next();
});

// Request ID and timing
app.use('*', async (c, next) => {
  c.set('requestId', uuidv4());
  c.set('requestStartTime', Date.now());
  await next();
});

// ============================================
// Error Handling
// ============================================

app.onError(errorHandler);

// ============================================
// Routes
// ============================================

// Health check routes
app.route('/health', healthRoutes);

// Root health check (convenience)
app.get('/', (c) => {
  return c.json({
    service: 'x402-skale-gateway',
    version: '1.0.0',
    docs: '/health/pricing',
    status: 'running',
  });
});

// S3 proxy routes (must be last - catches /:bucket/:key)
app.route('/', s3ProxyRoutes);

// ============================================
// 404 Handler
// ============================================

app.notFound((c) => {
  return c.json(
    {
      error: 'Not Found',
      code: 'NOT_FOUND',
      path: c.req.path,
    },
    404
  );
});

export default app;
