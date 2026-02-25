/**
 * PostgreSQL Database Module for AI Service
 *
 * Provides PostgreSQL connectivity and AI-specific operations.
 */

import pg, { QueryResultRow } from 'pg';
import { config } from '../config/index.js';
const { Pool } = pg;

// Pool instance
let pool: pg.Pool | null = null;

// Get configuration from validated Zod config
export function getPostgresConfig() {
  return {
    host: config.postgresHost,
    port: config.postgresPort,
    database: config.postgresDb,
    user: config.postgresUser,
    password: config.postgresPassword,
    ssl: config.postgresSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

// Create and configure the connection pool
export function createPostgresPool(): pg.Pool {
  if (pool) {
    return pool;
  }

  const config = getPostgresConfig();
  pool = new Pool(config);

  pool.on('error', (err) => {
    console.error('[database] Unexpected PostgreSQL pool error:', err);
  });

  pool.on('connect', () => {
    console.log('[database] PostgreSQL client connected');
  });

  return pool;
}

// Get the pool instance
export function getPool(): pg.Pool {
  if (!pool) {
    return createPostgresPool();
  }
  return pool;
}

// Execute a query
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params);
}

// Close the pool
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Verify database connection
export async function verifyConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT 1 as connected');
    return result.rows[0]?.connected === 1;
  } catch (error) {
    console.error('[database] PostgreSQL connection verification failed:', error);
    return false;
  }
}

// ============================================
// AI Generation Operations
// ============================================

export interface AiGeneration {
  id: string;
  user_email: string;
  prompt: string;
  status: 'pending' | 'generating' | 'publishing' | 'completed' | 'error';
  status_message: string | null;
  result_cid: string | null;
  gateway_url: string | null;
  error_message: string | null;
  assets: any[];
  credits_charged: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// Create a new generation record
export async function createGeneration(
  id: string,
  email: string,
  prompt: string,
  assets: any[],
  creditsCharged: number
): Promise<string> {
  const result = await query(
    `INSERT INTO ai_generations (id, user_email, prompt, assets, credits_charged, status, status_message)
     VALUES ($1, $2, $3, $4, $5, 'pending', 'Queued for generation')
     RETURNING id`,
    [id, email, prompt, JSON.stringify(assets), creditsCharged]
  );
  return result.rows[0].id;
}

// Update generation status
export async function updateGenerationStatus(
  id: string,
  status: string,
  statusMessage?: string
): Promise<void> {
  await query(
    `UPDATE ai_generations
     SET status = $1, status_message = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [status, statusMessage || null, id]
  );
}

// Complete a generation with result
export async function completeGeneration(
  id: string,
  resultCid: string,
  gatewayUrl: string
): Promise<void> {
  await query(
    `UPDATE ai_generations
     SET status = 'completed', result_cid = $1, gateway_url = $2,
         status_message = 'Website generated successfully',
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [resultCid, gatewayUrl, id]
  );
}

// Fail a generation with error
export async function failGeneration(
  id: string,
  errorMessage: string
): Promise<void> {
  await query(
    `UPDATE ai_generations
     SET status = 'error', error_message = $1,
         status_message = 'Generation failed',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [errorMessage, id]
  );
}

// Get a single generation by ID
export async function getGeneration(id: string): Promise<AiGeneration | null> {
  const result = await query<AiGeneration>(
    `SELECT * FROM ai_generations WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Get paginated generations for a user
export async function getGenerationsByUser(
  email: string,
  page: number = 1,
  limit: number = 20
): Promise<{ generations: AiGeneration[]; total: number }> {
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query<AiGeneration>(
      `SELECT * FROM ai_generations
       WHERE user_email = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [email, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ai_generations WHERE user_email = $1`,
      [email]
    ),
  ]);

  return {
    generations: dataResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

// Count recent jobs by user (for rate limiting)
export async function countRecentJobsByUser(
  email: string,
  sinceHours: number = 1
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ai_generations
     WHERE user_email = $1
     AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour' * $2`,
    [email, sinceHours]
  );
  return parseInt(result.rows[0].count, 10);
}

export default {
  createPostgresPool,
  getPool,
  query,
  closePool,
  verifyConnection,
  createGeneration,
  updateGenerationStatus,
  completeGeneration,
  failGeneration,
  getGeneration,
  getGenerationsByUser,
  countRecentJobsByUser,
};
