/**
 * Health Check Routes
 *
 * Provides health and status endpoints.
 */

import { Hono } from 'hono';
import type { Env, HealthResponse } from '../types/index.js';
import { getDatabase } from '../database/index.js';
import { getPricingInfo, getPricingConfig } from '../services/pricing.js';
import { getCleanupStats } from '../database/repositories/ephemeralObjects.js';

const startTime = Date.now();

export const healthRoutes = new Hono<Env>();

/**
 * GET /health
 *
 * Basic health check endpoint.
 */
healthRoutes.get('/', (c) => {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';

  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
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
healthRoutes.get('/detailed', (c) => {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';
  let cleanupStats = null;

  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
    dbStatus = 'connected';
    cleanupStats = getCleanupStats();
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
