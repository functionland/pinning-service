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

import { healthRoutes } from './routes/health.js';
import { generateRoutes } from './routes/generate.js';

interface Env {
  Variables: {
    requestId: string;
    requestStartTime: number;
  };
}

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
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['Content-Type'],
    maxAge: 86400,
  })
);

// Request ID
app.use('*', async (c, next) => {
  c.set('requestId', uuidv4());
  c.set('requestStartTime', Date.now());
  await next();
});

// ============================================
// Error Handling
// ============================================

app.onError((error, c) => {
  console.error('[error]', error);

  if (error.name === 'ZodError') {
    return c.json(
      { error: 'Validation error', details: (error as any).errors },
      400
    );
  }

  return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
});

// ============================================
// Routes
// ============================================

// Health check
app.route('/health', healthRoutes);

// Root
app.get('/', (c) => {
  return c.json({
    service: 'fula-ai-service',
    version: '1.0.0',
    status: 'running',
  });
});

// Generation API routes
app.route('/api/v1', generateRoutes);

// ============================================
// 404 Handler
// ============================================

app.notFound((c) => {
  return c.json(
    { error: 'Not Found', code: 'NOT_FOUND', path: c.req.path },
    404
  );
});

export default app;
