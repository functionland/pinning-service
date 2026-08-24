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
  user_id: string | null;
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
  enable_tracking: boolean;
  pipeline_version: number | null;
  // Public directory ("yellow pages") — migration 007.
  listed: boolean;
  listing_name: string | null;
  listing_description: string | null;
  listing_category: string | null;
  listing_generated_at: string | null;
  delisted_by_admin: boolean;
  listing_group: string | null;
}

// Create a new generation record (stores userId hash, not plain-text email)
//
// `listed` / `listingName` drive the public directory. Listing is OPT-IN:
// the column defaults to false, the client defaults to false, and the
// app's consent checkbox starts unticked (a pre-ticked box is not
// consent — GDPR Recital 32). A row is listed only when a user asked.
export async function createGeneration(
  id: string,
  userId: string,
  prompt: string,
  assets: any[],
  creditsCharged: number,
  enableTracking: boolean,
  pipelineVersion: number | null = null,
  listed: boolean = false,
  listingName: string | null = null,
  // Per-WEBSITE key (the client's tag id). Every regeneration is its own
  // row; without this the directory would list one entry per version.
  listingGroup: string | null = null
): Promise<string> {
  const result = await query(
    `INSERT INTO ai_generations (id, user_id, prompt, assets, credits_charged, status, status_message, enable_tracking, pipeline_version, listed, listing_name, listing_group)
     VALUES ($1, $2, $3, $4, $5, 'pending', 'Queued for generation', $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      id,
      userId,
      prompt,
      JSON.stringify(assets),
      creditsCharged,
      enableTracking,
      pipelineVersion,
      listed,
      listingName,
      listingGroup,
    ]
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

/** `ai_generations.id` is a Postgres UUID column. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGenerationId(id: string): boolean {
  return UUID_RE.test(id);
}

// Get a single generation by ID
//
// A malformed id is treated as "not found" rather than being handed to
// Postgres. `id` is a UUID column, so `WHERE id = 'abc'` raises
// `invalid input syntax for type uuid` — which surfaces as a 500 through
// the app error handler, when the honest answer to "is there a
// generation called abc" is 404. Every caller already handles null.
export async function getGeneration(id: string): Promise<AiGeneration | null> {
  if (!isGenerationId(id)) return null;
  const result = await query<AiGeneration>(
    `SELECT * FROM ai_generations WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Get paginated generations for a user (matches by user_id hash or legacy user_email)
export async function getGenerationsByUser(
  userId: string,
  page: number = 1,
  limit: number = 20
): Promise<{ generations: AiGeneration[]; total: number }> {
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query<AiGeneration>(
      `SELECT * FROM ai_generations
       WHERE (user_id = $1 OR user_email = $1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ai_generations WHERE (user_id = $1 OR user_email = $1)`,
      [userId]
    ),
  ]);

  return {
    generations: dataResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

// Count recent jobs by user (for rate limiting)
export async function countRecentJobsByUser(
  userId: string,
  sinceHours: number = 1
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ai_generations
     WHERE (user_id = $1 OR user_email = $1)
     AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour' * $2`,
    [userId, sinceHours]
  );
  return parseInt(result.rows[0].count, 10);
}

// Count free completed generations for a user (for free tier eligibility)
export async function countFreeCompletedGenerations(
  userId: string
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ai_generations
     WHERE (user_id = $1 OR user_email = $1) AND credits_charged = 0 AND status = 'completed'`,
    [userId]
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
  countFreeCompletedGenerations,
};
