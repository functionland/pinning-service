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
// Security: Vulnerability Scanner Protection
// ============================================

// Track IPs making suspicious requests (auto-block after repeated probes)
const suspiciousIps = new Map<string, { count: number; blockedUntil: number }>();

// Clean up stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of suspiciousIps) {
    if (record.blockedUntil < now && now - record.blockedUntil > 30 * 60 * 1000) {
      suspiciousIps.delete(ip);
    }
  }
}, 30 * 60 * 1000).unref();

// Patterns that are never legitimate for this service
const PROBE_PATTERN =
  /\.(env|git|svn|htaccess|htpasswd|DS_Store)|wp-config|phpinfo|phpmyadmin|\.php$|\.asp$|\.aspx$|\.jsp$|\.cgi$|\.sql$|\.bak$|\.old$|\.save$|\.swp$|\/cgi-bin/i;

app.use('*', async (c, next) => {
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown';

  // If IP is already blocked, reject immediately with no body
  const record = suspiciousIps.get(ip);
  if (record && record.blockedUntil > Date.now()) {
    return c.body(null, 403);
  }

  // Block known vulnerability probe paths
  if (PROBE_PATTERN.test(c.req.path)) {
    const r = suspiciousIps.get(ip) || { count: 0, blockedUntil: 0 };
    r.count++;
    if (r.count >= 5) {
      r.blockedUntil = Date.now() + 15 * 60 * 1000; // 15 min ban
      console.warn(
        `[security] Blocked IP ${ip} for 15 min (${r.count} probe attempts)`
      );
    }
    suspiciousIps.set(ip, r);
    return c.body(null, 403);
  }

  await next();
});

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
  // Don't leak path info — scanners use it for reconnaissance
  return c.json({ error: 'Not Found', code: 'NOT_FOUND' }, 404);
});

export default app;
