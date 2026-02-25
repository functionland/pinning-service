/**
 * Health Check Routes
 */

import { Hono } from 'hono';
import { query } from '../database/index.js';
import { getActiveJobCount, getQueuedJobCount } from '../services/generationService.js';

const startTime = Date.now();

export const healthRoutes = new Hono();

/**
 * GET /health
 */
healthRoutes.get('/', async (c) => {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';

  try {
    await query('SELECT 1');
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }

  return c.json(
    {
      status: dbStatus === 'connected' ? 'ok' : 'error',
      service: 'fula-ai-service',
      version: '1.0.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      database: dbStatus,
      activeJobs: getActiveJobCount(),
      queuedJobs: getQueuedJobCount(),
      timestamp: new Date().toISOString(),
    },
    dbStatus === 'connected' ? 200 : 503
  );
});

export default healthRoutes;
