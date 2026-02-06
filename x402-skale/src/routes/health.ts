/**
 * Health Check Routes
 *
 * Provides health and status endpoints.
 */

import { Hono } from 'hono';
import type { Env, HealthResponse } from '../types/index.js';
import { query } from '../database/index.js';
import { getPricingInfo, getPricingConfig } from '../services/pricing.js';
import { getCleanupStats } from '../database/repositories/ephemeralObjects.js';
import { triggerCleanup } from '../services/cleanup.js';

const startTime = Date.now();

export const healthRoutes = new Hono<Env>();

/**
 * GET /health
 *
 * Basic health check endpoint.
 */
healthRoutes.get('/', async (c) => {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';

  try {
    await query('SELECT 1');
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }

  const response: HealthResponse = {
    status: dbStatus === 'connected' ? 'ok' : 'error',
    version: '1.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    database: dbStatus,
    timestamp: new Date().toISOString(),
  };

  return c.json(response, dbStatus === 'connected' ? 200 : 503);
});

/**
 * GET /health/detailed
 *
 * Detailed health check with stats.
 */
healthRoutes.get('/detailed', async (c) => {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';
  let cleanupStats = null;

  try {
    await query('SELECT 1');
    dbStatus = 'connected';
    cleanupStats = await getCleanupStats();
  } catch {
    dbStatus = 'disconnected';
  }

  return c.json({
    status: dbStatus === 'connected' ? 'ok' : 'error',
    version: '1.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    uptimeFormatted: formatUptime(Date.now() - startTime),
    database: dbStatus,
    timestamp: new Date().toISOString(),
    ephemeralObjects: cleanupStats,
  });
});

/**
 * GET /health/pricing
 *
 * Returns pricing information.
 */
healthRoutes.get('/pricing', (c) => {
  return c.json({
    ...getPricingConfig(),
    ...getPricingInfo(),
  });
});

/**
 * POST /health/cleanup
 *
 * Manually trigger cleanup of expired objects (for testing).
 * Protected by admin token.
 */
healthRoutes.post('/cleanup', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth || !auth.includes(process.env.S3_ADMIN_TOKEN || '__never_match__')) {
    return c.json({ error: 'Admin token required' }, 403);
  }

  const result = await triggerCleanup();
  return c.json({
    ...result,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Format uptime in human-readable format
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export default healthRoutes;
