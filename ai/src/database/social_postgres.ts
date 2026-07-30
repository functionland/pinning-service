/**
 * PostgreSQL operations for social posts (ai_social_posts).
 *
 * Mirrors the ai_generations DAL in postgres.ts. Rows are created only for
 * charged jobs — user_id is always the sha256 hash (no legacy email column).
 */

import { query } from './postgres.js';

export interface AiSocialPost {
  id: string;
  user_id: string;
  generation_id: string | null;
  prompt: string;
  website_url: string;
  asset_prefix: string;
  assets: any[];
  status: 'pending' | 'generating' | 'publishing' | 'completed' | 'error';
  status_message: string | null;
  image_cid: string | null;
  image_url: string | null;
  captions: { long: string; short: string } | null;
  error_message: string | null;
  credits_charged: number;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function createSocialPost(params: {
  id: string;
  userId: string;
  generationId: string | null;
  prompt: string;
  websiteUrl: string;
  assetPrefix: string;
  assets: any[];
  creditsCharged: number;
  idempotencyKey: string | null;
}): Promise<string> {
  const result = await query(
    `INSERT INTO ai_social_posts
       (id, user_id, generation_id, prompt, website_url, asset_prefix, assets,
        credits_charged, idempotency_key, status, status_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             'pending', 'Queued for social post generation')
     RETURNING id`,
    [
      params.id,
      params.userId,
      params.generationId,
      params.prompt,
      params.websiteUrl,
      params.assetPrefix,
      JSON.stringify(params.assets),
      params.creditsCharged,
      params.idempotencyKey,
    ]
  );
  return result.rows[0].id;
}

export async function getSocialPost(id: string): Promise<AiSocialPost | null> {
  const result = await query<AiSocialPost>(
    `SELECT * FROM ai_social_posts WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function findSocialPostByIdempotency(
  userId: string,
  idempotencyKey: string
): Promise<AiSocialPost | null> {
  const result = await query<AiSocialPost>(
    `SELECT * FROM ai_social_posts WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey]
  );
  return result.rows[0] || null;
}

export async function updateSocialPostStatus(
  id: string,
  status: string,
  statusMessage?: string
): Promise<void> {
  // Progress writes are gated on the row still being non-terminal so a
  // straggling executor can never resurrect a row the reaper (or a timeout)
  // already terminalized and refunded.
  await query(
    `UPDATE ai_social_posts
     SET status = $1, status_message = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND status IN ('pending', 'generating', 'publishing')`,
    [status, statusMessage || null, id]
  );
}

/** True when [cid] is the image CID of any social-post row — the public
 *  passthrough serves ONLY images this feature generated. */
export async function socialPostExistsByImageCid(cid: string): Promise<boolean> {
  const result = await query<{ one: number }>(
    `SELECT 1 as one FROM ai_social_posts WHERE image_cid = $1 LIMIT 1`,
    [cid]
  );
  return result.rows.length > 0;
}

/**
 * Terminal transitions are CONDITIONAL (row must still be non-terminal) so a
 * straggling executor from a previous process can never overwrite a state the
 * boot reaper already terminalized (and refunded). Returns true iff THIS call
 * won the transition — the caller must gate refunds on it.
 */
export async function completeSocialPost(
  id: string,
  imageCid: string,
  imageUrl: string,
  captions: { long: string; short: string }
): Promise<boolean> {
  const result = await query(
    `UPDATE ai_social_posts
     SET status = 'completed', image_cid = $1, image_url = $2, captions = $3,
         status_message = 'Social post ready',
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $4 AND status IN ('pending', 'generating', 'publishing')`,
    [imageCid, imageUrl, JSON.stringify(captions), id]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function failSocialPost(id: string, errorMessage: string): Promise<boolean> {
  const result = await query(
    `UPDATE ai_social_posts
     SET status = 'error', error_message = $1,
         status_message = 'Social post generation failed',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND status IN ('pending', 'generating', 'publishing')`,
    [errorMessage, id]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function countRecentSocialJobsByUser(
  userId: string,
  sinceHours: number = 1
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ai_social_posts
     WHERE user_id = $1
     AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour' * $2`,
    [userId, sinceHours]
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Boot reaper: flip every stale non-terminal row (bounded age) to error and
 * return exactly the rows flipped, so refunds happen exactly once even if
 * boot repeats — a row already flipped won't be RETURNED again.
 */
export async function reapStaleSocialPosts(): Promise<
  Array<{ id: string; user_id: string; credits_charged: number }>
> {
  const result = await query<{ id: string; user_id: string; credits_charged: number }>(
    `UPDATE ai_social_posts
     SET status = 'error',
         error_message = 'Service restarted while the job was running',
         status_message = 'Social post generation failed',
         updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('pending', 'generating', 'publishing')
       AND created_at > CURRENT_TIMESTAMP - INTERVAL '7 days'
     RETURNING id, user_id, credits_charged`
  );
  return result.rows;
}
