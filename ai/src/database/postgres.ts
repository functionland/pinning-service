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
  // Revision ("Recreate") — migration 010. Non-null means this job edits
  // an existing site instead of designing a new one.
  base_generation_id: string | null;
  revision_request: string | null;
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
  listingGroup: string | null = null,
  // Revision: the generation this job EDITS, already resolved and
  // ownership-checked by the route, plus what the user asked to change.
  baseGenerationId: string | null = null,
  revisionRequest: string | null = null
): Promise<string> {
  const result = await query(
    `INSERT INTO ai_generations (id, user_id, prompt, assets, credits_charged, status, status_message, enable_tracking, pipeline_version, listed, listing_name, listing_group, base_generation_id, revision_request)
     VALUES ($1, $2, $3, $4, $5, 'pending', 'Queued for generation', $6, $7, $8, $9, $10, $11, $12)
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
      baseGenerationId,
      revisionRequest,
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

// ============================================
// Revision base (migration 010)
// ============================================
//
// The model's RAW output files, kept so "Recreate" can edit an existing
// site instead of generating a new one. They live in their own table
// because the reads above are `SELECT *` and the client polls status
// every ~2s — see migrations/010_generation_files.sql.

export interface GenerationFile {
  path: string;
  content: string;
}

/** The prior generation a revision builds on. */
export interface RevisionBase {
  id: string;
  /** Enriched prompt the base was generated from — diffed against the new
   *  one to tell the model which SETTINGS the user changed. */
  prompt: string;
  assets: any[];
  files: GenerationFile[];
  /** Where the base site is published. Lets a revision that turns out to
   *  change nothing answer with the site the user already has. */
  resultCid: string | null;
  gatewayUrl: string | null;
  /** Publish-time flag: the same source published with tracking flipped
   *  is a different site, so it is NOT an unchanged revision. */
  enableTracking: boolean;
}

/**
 * Store a completed generation's raw files. Upsert rather than insert:
 * migrations re-run and jobs can be retried, and a second write for the
 * same generation is a correction, not a conflict.
 */
export async function saveGenerationFiles(
  generationId: string,
  files: GenerationFile[]
): Promise<void> {
  await query(
    `INSERT INTO ai_generation_files (generation_id, files)
     VALUES ($1, $2)
     ON CONFLICT (generation_id)
     DO UPDATE SET files = EXCLUDED.files, created_at = CURRENT_TIMESTAMP`,
    [generationId, JSON.stringify(files)]
  );
}

/**
 * Load a revision base by its generation id.
 *
 * Used by the worker, which reads `base_generation_id` — a value the
 * ROUTE resolved and ownership-checked before the job was created. No
 * user scoping here on purpose: re-deriving it from client input is what
 * would let a crafted request reach another account's source.
 */
export async function getRevisionBaseById(
  generationId: string
): Promise<RevisionBase | null> {
  if (!isGenerationId(generationId)) return null;
  const result = await query<RevisionBaseRow>(
    `SELECT g.id, g.prompt, g.assets, g.result_cid, g.gateway_url,
            g.enable_tracking, f.files
       FROM ai_generations g
       LEFT JOIN ai_generation_files f ON f.generation_id = g.id
      WHERE g.id = $1`,
    [generationId]
  );
  return toRevisionBase(result.rows[0]);
}

interface RevisionBaseRow {
  id: string;
  prompt: string;
  assets: any[];
  result_cid: string | null;
  gateway_url: string | null;
  enable_tracking: boolean | null;
  files: GenerationFile[] | null;
}

function toRevisionBase(row: RevisionBaseRow | undefined): RevisionBase | null {
  if (!row) return null;
  return {
    id: row.id,
    prompt: row.prompt,
    assets: row.assets || [],
    // A row with no files is still a real base — the caller decides
    // whether it can work without the source.
    files: Array.isArray(row.files) ? row.files : [],
    resultCid: row.result_cid,
    gatewayUrl: row.gateway_url,
    enableTracking: row.enable_tracking === true,
  };
}

/**
 * Resolve a client-supplied `base_cid` to the caller's own prior
 * generation and its stored source.
 *
 * Scoped to the caller on BOTH the row and the files: a CID is derived
 * from content, so two users who generate byte-identical sites share one
 * — matching on the CID alone would hand one user another's source.
 *
 * `ORDER BY completed_at DESC LIMIT 1` because a CID legitimately repeats
 * within one account: a no-op revision republishes identical bytes and so
 * lands on the same CID as the generation it came from.
 *
 * Returns null when the CID is unknown to this user, or when the row
 * predates migration 010 and has no stored source (the caller then falls
 * back to the published copy, or to a fresh generation).
 */
export async function findRevisionBase(
  resultCid: string,
  userId: string
): Promise<RevisionBase | null> {
  const result = await query<RevisionBaseRow>(
    `SELECT g.id, g.prompt, g.assets, g.result_cid, g.gateway_url,
            g.enable_tracking, f.files
       FROM ai_generations g
       LEFT JOIN ai_generation_files f ON f.generation_id = g.id
      WHERE g.result_cid = $1
        AND (g.user_id = $2 OR g.user_email = $2)
        AND g.status = 'completed'
      ORDER BY g.completed_at DESC NULLS LAST
      LIMIT 1`,
    [resultCid, userId]
  );
  return toRevisionBase(result.rows[0]);
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
  saveGenerationFiles,
  findRevisionBase,
  getRevisionBaseById,
};
