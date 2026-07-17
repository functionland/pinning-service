import { query, getPool } from './postgres.js';

export async function createAskGeneration(
  id: string,
  userId: string,
  fileCount: number,
  creditsCharged: number,
  status: string
): Promise<void> {
  await query(
    `INSERT INTO ask_generations (id, user_id, file_count, credits_charged, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, fileCount, creditsCharged, status]
  );
}

export async function claimFreeAskGeneration(userId: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    
    // Check if the row exists, lock it for update
    let result = await client.query(
      `SELECT free_ask_used FROM ask_user_stats WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );

    if (result.rows.length === 0) {
      // Row doesn't exist, this means free ask is not used yet. Insert and lock.
      await client.query(
        `INSERT INTO ask_user_stats (user_id, free_ask_used) VALUES ($1, true)`,
        [userId]
      );
      await client.query('COMMIT');
      return true; // Successfully claimed
    } else {
      if (!result.rows[0].free_ask_used) {
        await client.query(
          `UPDATE ask_user_stats SET free_ask_used = true WHERE user_id = $1`,
          [userId]
        );
        await client.query('COMMIT');
        return true; // Successfully claimed
      }
    }
    
    await client.query('COMMIT');
    return false; // Already claimed
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cacheAskResponse(key: string, responseText: string): Promise<void> {
  await query(
    `INSERT INTO ask_response_cache (idempotency_key, response_text)
     VALUES ($1, $2)
     ON CONFLICT (idempotency_key) DO UPDATE SET response_text = $2`,
    [key, responseText]
  );
}

export async function getCachedAskResponse(key: string): Promise<string | null> {
  const result = await query(
    `SELECT response_text FROM ask_response_cache WHERE idempotency_key = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [key]
  );
  return result.rows[0]?.response_text || null;
}

export async function cleanupExpiredAskCache(): Promise<void> {
  await query(
    `DELETE FROM ask_response_cache WHERE created_at <= NOW() - INTERVAL '1 hour'`
  );
}
