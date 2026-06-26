/**
 * PostgreSQL Database Module for Pinning WebUI
 *
 * This module provides PostgreSQL connectivity for the pinning-webui.
 * All operations are async and use connection pooling.
 */

import pg, { QueryResultRow } from 'pg';
import crypto from 'crypto';
const { Pool } = pg;

/** SHA-256 hex digest of a session/API-key token for storage without plain text. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Pool instance
let pool: pg.Pool | null = null;

// PostgreSQL connection configuration from environment
export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

// Get configuration from environment
export function getPostgresConfig(): PostgresConfig {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'pinning_service',
    user: process.env.POSTGRES_USER || 'pinning_user',
    password: process.env.POSTGRES_PASSWORD || '',
    ssl: process.env.POSTGRES_SSL === 'true',
    max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '25', 10),
    idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT || '5000', 10),
  };
}

// Create and configure the connection pool
export function createPostgresPool(config?: Partial<PostgresConfig>): pg.Pool {
  if (pool) {
    return pool;
  }

  const defaultConfig = getPostgresConfig();
  const finalConfig = { ...defaultConfig, ...config };

  pool = new Pool({
    host: finalConfig.host,
    port: finalConfig.port,
    database: finalConfig.database,
    user: finalConfig.user,
    password: finalConfig.password,
    ssl: finalConfig.ssl ? { rejectUnauthorized: false } : false,
    max: finalConfig.max,
    idleTimeoutMillis: finalConfig.idleTimeoutMillis,
    connectionTimeoutMillis: finalConfig.connectionTimeoutMillis,
  });

  // Error handling for pool
  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });

  // Connection logging
  pool.on('connect', () => {
    console.log('PostgreSQL client connected');
  });

  return pool;
}

// Get the pool instance (creates if not exists)
export function getPool(): pg.Pool {
  if (!pool) {
    return createPostgresPool();
  }
  return pool;
}

// Execute a query
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
  const p = getPool();
  const start = Date.now();
  const result = await p.query<T>(text, params);
  const duration = Date.now() - start;

  // Log slow queries (over 1 second)
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
  }

  return result;
}

// Get a client from the pool (for transactions)
export async function getClient(): Promise<pg.PoolClient> {
  const p = getPool();
  return p.connect();
}

// Close the pool
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Check if PostgreSQL is configured (has POSTGRES_HOST set)
export function isPostgresConfigured(): boolean {
  return !!process.env.POSTGRES_HOST;
}

// Verify database connection
export async function verifyConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT 1 as connected');
    return result.rows[0]?.connected === 1;
  } catch (error) {
    console.error('PostgreSQL connection verification failed:', error);
    return false;
  }
}

// ============================================
// WebUI Database Operations (Async)
// ============================================

// Compute user_id from email (SHA-256 hex hash)
export function emailToUserId(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
}

// Get or create webui user
export async function getOrCreateWebuiUser(
  userId: string,
  email: string,
  name: string,
  picture: string,
  jwtSecret: string,
  generateJwtApiKey: (userId: string, jwtSecret: string) => string,
  referralCode?: string
): Promise<{ email: string; name: string; picture: string; isNew: boolean }> {
  const existing = await query<any>(
    'SELECT * FROM webui_users WHERE user_id = $1',
    [userId]
  );

  if (existing.rows[0]) {
    // Decrypt name/picture from DB (legacy rows store plain-text, new rows are encrypted)
    const row = existing.rows[0];
    let decName = row.name, decPicture = row.picture;
    try { const d = decryptApiKey(row.name); if (d) decName = d; } catch { /* legacy plain-text */ }
    try { const d = decryptApiKey(row.picture); if (d) decPicture = d; } catch { /* legacy plain-text */ }

    // Re-encrypt with fresh values from OAuth and update
    const encryptedName = encryptApiKey(name) || name;
    const encryptedPicture = encryptApiKey(picture) || picture;
    await query(
      'UPDATE webui_users SET last_login_at = NOW(), name = $1, picture = $2 WHERE user_id = $3',
      [encryptedName, encryptedPicture, userId]
    );

    // Link referral for existing users who don't have one yet
    // (handles: user created before getting referral link, or prior registration error)
    if (referralCode) {
      const existingReferral = await query('SELECT 1 FROM referrals WHERE referred_id = $1', [userId]);
      if (!existingReferral.rows[0]) {
        const referrer = await query<{ user_id: string }>(
          'SELECT user_id FROM referral_codes WHERE code = $1',
          [referralCode]
        );
        const referrerId = referrer.rows[0]?.user_id;
        if (referrerId && referrerId !== userId) {
          // Cycle guard: ensure userId is not an ancestor of referrerId
          const cycleCheck = await query(`
            WITH RECURSIVE up AS (
              SELECT referrer_id, 1 AS depth FROM referrals WHERE referred_id = $1
              UNION ALL
              SELECT r.referrer_id, up.depth + 1
              FROM referrals r JOIN up ON r.referred_id = up.referrer_id
              WHERE up.depth < 100
            )
            SELECT 1 FROM up WHERE referrer_id = $2 LIMIT 1
          `, [referrerId, userId]);

          if (cycleCheck.rows.length === 0) {
            await query(
              'INSERT INTO referrals (referrer_id, referred_id, referral_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [referrerId, userId, referralCode]
            );
          } else {
            console.warn(`[webui] Blocked circular referral: ${userId} -> ${referrerId} -> ... -> ${userId}`);
          }
        }
      }
    }

    return { ...row, name: decName, picture: decPicture, isNew: false };
  }

  // Look up referrer's code name for inheritance (do this first so we can set company)
  let inheritedName: string | null = null;
  if (referralCode) {
    const referrerCodeInfo = await query<{ name: string | null; inherited_name: string | null }>(
      'SELECT name, inherited_name FROM referral_codes WHERE code = $1',
      [referralCode]
    );
    if (referrerCodeInfo.rows[0]) {
      // Inherit name: use the code's name first, or its inherited_name if no name
      inheritedName = referrerCodeInfo.rows[0].name || referrerCodeInfo.rows[0].inherited_name;
    }
  }

  // Insert new user — no plain-text email; store encrypted_email for OAuth recovery
  const encryptedEmail = encryptApiKey(email); // reuses AES-256-GCM encryption
  const encryptedName = encryptApiKey(name) || name;
  const encryptedPicture = encryptApiKey(picture) || picture;
  await query(
    'INSERT INTO webui_users (user_id, encrypted_email, name, picture, last_login_at, company) VALUES ($1, $2, $3, $4, NOW(), $5)',
    [userId, encryptedEmail, encryptedName, encryptedPicture, inheritedName]
  );

  // Create first API key automatically — no plain-text key_id for new records
  const keyId = generateJwtApiKey(userId, jwtSecret);
  const encryptedKey = encryptApiKey(keyId);
  const keyHash = hashToken(keyId);
  await query(
    'INSERT INTO api_keys (key_hash, user_id, encrypted_key) VALUES ($1, $2, $3)',
    [keyHash, userId, encryptedKey]
  );

  // Also create entry in main users/sessions tables for pinning service compatibility
  const existingMainUser = await query('SELECT * FROM users WHERE user_id = $1', [userId]);
  if (!existingMainUser.rows[0]) {
    const { v4: uuidv4 } = await import('uuid');
    await query(
      'INSERT INTO users (user_id, password_hash, pool_id) VALUES ($1, $2, 1)',
      [userId, 'google-oauth-user-' + uuidv4()]
    );
  }

  // Create session: store hash in both session_token (for UNIQUE constraint) and token_hash.
  // No plain-text token or username stored for new entries.
  const tokenHash = hashToken(keyId);
  await query(
    `INSERT INTO sessions (session_token, token_hash, user_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (session_token) DO UPDATE SET token_hash = $2, user_id = $3, created_at = NOW()`,
    [tokenHash, tokenHash, userId]
  );

  // Generate referral code for this new user
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let newReferralCode = '';
  for (let i = 0; i < 8; i++) {
    newReferralCode += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  // Ensure uniqueness with retry loop
  let codeExists = await query('SELECT 1 FROM referral_codes WHERE code = $1', [newReferralCode]);
  while (codeExists.rows[0]) {
    newReferralCode = '';
    for (let i = 0; i < 8; i++) {
      newReferralCode += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    codeExists = await query('SELECT 1 FROM referral_codes WHERE code = $1', [newReferralCode]);
  }

  // Insert with is_default and inherited_name (write userId to user_email — no plain-text email)
  await query(
    'INSERT INTO referral_codes (user_id, user_email, code, is_default, inherited_name) VALUES ($1, $2, $3, TRUE, $4)',
    [userId, userId, newReferralCode, inheritedName]
  );

  // If referred by someone, create referral record
  if (referralCode) {
    const referrer = await query<{ user_id: string }>(
      'SELECT user_id FROM referral_codes WHERE code = $1',
      [referralCode]
    );
    const referrerId = referrer.rows[0]?.user_id;
    // Prevent self-referral and only link if referrer exists
    if (referrerId && referrerId !== userId) {
      // Cycle guard: ensure userId is not an ancestor of referrerId
      const cycleCheck = await query(`
        WITH RECURSIVE up AS (
          SELECT referrer_id, 1 AS depth FROM referrals WHERE referred_id = $1
          UNION ALL
          SELECT r.referrer_id, up.depth + 1
          FROM referrals r JOIN up ON r.referred_id = up.referrer_id
          WHERE up.depth < 100
        )
        SELECT 1 FROM up WHERE referrer_id = $2 LIMIT 1
      `, [referrerId, userId]);

      if (cycleCheck.rows.length === 0) {
        await query(
          'INSERT INTO referrals (referrer_id, referred_id, referral_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [referrerId, userId, referralCode]
        );
      } else {
        console.warn(`[webui] Blocked circular referral: ${userId} -> ${referrerId} -> ... -> ${userId}`);
      }
    }
  }

  return { email, name, picture, isNew: true };
}

// Get user by user_id
export async function getWebuiUserById(userId: string): Promise<any> {
  const result = await query('SELECT * FROM webui_users WHERE user_id = $1', [userId]);
  return result.rows[0];
}

// Backward-compatible alias
export const getWebuiUserByEmail = getWebuiUserById;

// Get API keys (decrypts encrypted_key if available, falls back to key_id)
export async function getApiKeys(userId: string): Promise<any[]> {
  const result = await query(
    'SELECT key_id, encrypted_key, created_at, last_used_at FROM api_keys WHERE user_id = $1 AND is_deleted = 0 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows
    .map((row: any) => {
      let displayKey = row.key_id;
      if (row.encrypted_key) {
        try {
          const decrypted = decryptApiKey(row.encrypted_key);
          if (decrypted) displayKey = decrypted;
        } catch { /* fallback to key_id */ }
      }
      if (!displayKey) return null; // key_id wiped and no encrypted_key — not displayable
      return {
        key_id: displayKey,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
      };
    })
    .filter(Boolean);
}

// Create API key (no plain-text key_id for new records)
export async function createApiKey(
  userId: string,
  jwtSecret: string,
  generateJwtApiKey: (userId: string, jwtSecret: string) => string
): Promise<string> {
  const keyId = generateJwtApiKey(userId, jwtSecret);
  const encryptedKey = encryptApiKey(keyId);
  const keyHash = hashToken(keyId);
  await query(
    'INSERT INTO api_keys (key_hash, user_id, user_email, encrypted_key) VALUES ($1, $2, $3, $4)',
    [keyHash, userId, userId, encryptedKey]
  );

  // Also create corresponding session for pinning service (hash only, no plain-text token)
  const apiTokenHash = hashToken(keyId);
  await query(
    `INSERT INTO sessions (session_token, token_hash, user_id, username, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (session_token) DO UPDATE SET token_hash = $2, user_id = $3, username = $4, created_at = NOW()`,
    [apiTokenHash, apiTokenHash, userId, userId]
  );

  return keyId;
}

// Delete API key (match by key_hash or legacy key_id)
export async function deleteApiKey(userId: string, keyId: string): Promise<boolean> {
  const keyHash = hashToken(keyId);
  const result = await query(
    'UPDATE api_keys SET is_deleted = 1, deleted_at = NOW() WHERE user_id = $1 AND (key_hash = $2 OR key_id = $3) AND is_deleted = 0',
    [userId, keyHash, keyId]
  );

  // Remove from sessions table (match by token_hash or legacy session_token)
  const delHash = hashToken(keyId);
  await query('DELETE FROM sessions WHERE (token_hash = $1 OR session_token = $2) AND user_id = $3', [delHash, keyId, userId]);

  return (result.rowCount || 0) > 0;
}

// Get user pins
export async function getUserPins(
  userId: string,
  page: number,
  limit: number,
  search?: string
): Promise<{ pins: any[]; total: number }> {
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE user_id = $1 AND status != \'deleted\'';
  const params: any[] = [userId];
  let paramIndex = 2;

  if (search && search.trim()) {
    whereClause += ` AND (cid LIKE $${paramIndex} OR requestid LIKE $${paramIndex + 1})`;
    const searchPattern = `%${search.trim()}%`;
    params.push(searchPattern, searchPattern);
    paramIndex += 2;
  }

  const pinsResult = await query(
    `SELECT requestid as request_id, cid, name, created_at, status, size
     FROM pins
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  const countResult = await query(
    `SELECT COUNT(*) as total FROM pins ${whereClause}`,
    params
  );

  return {
    pins: pinsResult.rows,
    total: parseInt(countResult.rows[0]?.total || '0', 10),
  };
}

// Get user stats
export async function getUserStats(userId: string): Promise<{
  totalPins: number;
  totalSize: number;
  lastLogin: string;
  memberSince: string;
}> {
  const statsResult = await query(
    `SELECT COUNT(*) as total_pins, COALESCE(SUM(size), 0) as total_size
     FROM pins
     WHERE user_id = $1 AND status != 'deleted'`,
    [userId]
  );

  const userResult = await query(
    'SELECT last_login_at, created_at FROM webui_users WHERE user_id = $1',
    [userId]
  );

  return {
    totalPins: parseInt(statsResult.rows[0]?.total_pins || '0', 10),
    totalSize: parseInt(statsResult.rows[0]?.total_size || '0', 10),
    lastLogin: userResult.rows[0]?.last_login_at,
    memberSince: userResult.rows[0]?.created_at,
  };
}

// Delete user profile
export async function deleteUserProfile(userId: string): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pins WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM referral_codes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM webui_users WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Add pin
export async function addPin(userId: string, cid: string, name?: string): Promise<string> {
  const { v4: uuidv4 } = await import('uuid');
  const requestId = uuidv4();

  await query(
    `INSERT INTO pins (requestid, user_id, username, cid, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), NOW())`,
    [requestId, userId, userId, cid, name || '']
  );

  return requestId;
}

// ============================================
// Referral System Operations
// ============================================

export async function getReferralCode(userId: string): Promise<string | null> {
  const result = await query<{ code: string }>(
    'SELECT code FROM referral_codes WHERE user_id = $1',
    [userId]
  );
  return result.rows[0]?.code || null;
}

export async function getReferralStats(userId: string): Promise<{
  totalReferred: number;
  referrals: Array<{ email: string; referredAt: string }>;
}> {
  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = $1',
    [userId]
  );

  const referralsResult = await query<{ referred_email: string; referred_at: string }>(
    'SELECT referred_email, referred_at FROM referrals WHERE referrer_user_id = $1 ORDER BY referred_at DESC LIMIT 50',
    [userId]
  );

  return {
    totalReferred: parseInt(countResult.rows[0]?.count || '0', 10),
    referrals: referralsResult.rows.map(r => ({
      email: r.referred_email,
      referredAt: r.referred_at,
    })),
  };
}

// Get all referral codes for a user
export interface ReferralCodeInfo {
  code: string;
  name: string | null;
  inheritedName: string | null;
  isDefault: boolean;
  createdAt: string;
}

export async function getUserReferralCodes(userId: string): Promise<ReferralCodeInfo[]> {
  const result = await query<{
    code: string;
    name: string | null;
    inherited_name: string | null;
    is_default: boolean;
    created_at: string;
  }>(
    `SELECT code, name, inherited_name, is_default, created_at
     FROM referral_codes
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at ASC`,
    [userId]
  );

  return result.rows.map(r => ({
    code: r.code,
    name: r.name,
    inheritedName: r.inherited_name,
    isDefault: r.is_default,
    createdAt: r.created_at,
  }));
}

// Create a new referral code for a user
export async function createUserReferralCode(
  userId: string,
  name: string | null
): Promise<{ code: string; error?: string }> {
  // Check max codes limit (10 per user)
  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM referral_codes WHERE user_id = $1',
    [userId]
  );
  const currentCount = parseInt(countResult.rows[0]?.count || '0', 10);
  if (currentCount >= 10) {
    return { code: '', error: 'Maximum of 10 referral codes allowed per user' };
  }

  // Truncate name to 50 chars if provided
  const truncatedName = name ? name.substring(0, 50) : null;

  // Generate unique code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let newCode = '';
  for (let i = 0; i < 8; i++) {
    newCode += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  let codeExists = await query('SELECT 1 FROM referral_codes WHERE code = $1', [newCode]);
  while (codeExists.rows[0]) {
    newCode = '';
    for (let i = 0; i < 8; i++) {
      newCode += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    codeExists = await query('SELECT 1 FROM referral_codes WHERE code = $1', [newCode]);
  }

  await query(
    'INSERT INTO referral_codes (user_id, user_email, code, name, is_default) VALUES ($1, $2, $3, $4, FALSE)',
    [userId, userId, newCode, truncatedName]
  );

  return { code: newCode };
}

// Update a referral code's name
export async function updateReferralCodeName(
  userId: string,
  code: string,
  name: string | null
): Promise<{ success: boolean; error?: string }> {
  // Truncate name to 50 chars if provided
  const truncatedName = name ? name.substring(0, 50) : null;

  const result = await query(
    'UPDATE referral_codes SET name = $1 WHERE user_id = $2 AND code = $3',
    [truncatedName, userId, code]
  );

  if ((result.rowCount || 0) === 0) {
    return { success: false, error: 'Referral code not found' };
  }

  return { success: true };
}

// Delete a referral code
export async function deleteUserReferralCode(
  userId: string,
  code: string
): Promise<{ success: boolean; error?: string }> {
  // Check if this code has any referrals
  const referralsResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM referrals WHERE referral_code = $1',
    [code]
  );
  const referralCount = parseInt(referralsResult.rows[0]?.count || '0', 10);
  if (referralCount > 0) {
    return { success: false, error: 'Cannot delete code with existing referrals' };
  }

  // Check if this is the only code
  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM referral_codes WHERE user_id = $1',
    [userId]
  );
  const totalCodes = parseInt(countResult.rows[0]?.count || '0', 10);
  if (totalCodes <= 1) {
    return { success: false, error: 'Cannot delete your only referral code' };
  }

  // Check if this is the default code
  const codeInfo = await query<{ is_default: boolean }>(
    'SELECT is_default FROM referral_codes WHERE user_id = $1 AND code = $2',
    [userId, code]
  );
  if (codeInfo.rows[0]?.is_default) {
    return { success: false, error: 'Cannot delete the default referral code' };
  }

  const result = await query(
    'DELETE FROM referral_codes WHERE user_id = $1 AND code = $2',
    [userId, code]
  );

  if ((result.rowCount || 0) === 0) {
    return { success: false, error: 'Referral code not found' };
  }

  return { success: true };
}

// ============================================
// API Key Encryption (AES-256-GCM at rest)
// ============================================

function getEncryptionKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

export function encryptApiKey(key: string): string | null {
  const encKey = getEncryptionKey();
  if (!encKey) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptApiKey(stored: string): string | null {
  const encKey = getEncryptionKey();
  if (!encKey) return null;
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ============================================
// API Key Verification
// ============================================

export async function verifyApiKey(keyId: string): Promise<string | null> {
  const keyHash = hashToken(keyId);

  // Primary: lookup by key_hash
  let result = await query<{ user_id: string | null; user_email: string }>(
    'SELECT user_id, user_email FROM api_keys WHERE key_hash = $1 AND is_deleted = 0',
    [keyHash]
  );

  // Fallback: legacy key_id (pre-migration rows without key_hash)
  if (!result.rows[0]) {
    result = await query<{ user_id: string | null; user_email: string }>(
      'SELECT user_id, user_email FROM api_keys WHERE key_id = $1 AND is_deleted = 0',
      [keyId]
    );
  }

  if (result.rows[0]) {
    // Update last_used_at
    await query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1 OR key_id = $2',
      [keyHash, keyId]
    );
    // Return user_id if available, otherwise compute from user_email for legacy keys
    return result.rows[0].user_id || emailToUserId(result.rows[0].user_email);
  }

  return null;
}

// ============================================
// Chain Sync State
// ============================================

export async function getChainSyncState(): Promise<any[]> {
  const result = await query('SELECT * FROM chain_sync_state WHERE is_enabled = 1');
  return result.rows;
}

export async function updateChainSyncState(chainId: number, lastScannedBlock: number): Promise<void> {
  await query(
    'UPDATE chain_sync_state SET last_scanned_block = $1, last_scan_at = NOW() WHERE chain_id = $2',
    [lastScannedBlock, chainId]
  );
}

// ============================================
// App Download Tracking
// ============================================

export async function markAppDownloaded(userId: string): Promise<void> {
  await query(
    'UPDATE webui_users SET app_downloaded = 1, app_downloaded_at = NOW() WHERE user_id = $1 AND app_downloaded = 0',
    [userId]
  );
}

// ============================================
// User Company/Organization
// ============================================

export async function getUserCompany(userId: string): Promise<string | null> {
  const result = await query<{ company: string | null }>(
    'SELECT company FROM webui_users WHERE user_id = $1',
    [userId]
  );
  return result.rows[0]?.company || null;
}

export async function updateUserCompany(userId: string, company: string | null): Promise<boolean> {
  // Truncate company to 100 chars if provided
  const truncatedCompany = company ? company.substring(0, 100) : null;

  const result = await query(
    'UPDATE webui_users SET company = $1 WHERE user_id = $2',
    [truncatedCompany, userId]
  );
  return (result.rowCount || 0) > 0;
}

// ============================================
// MCP scoped-token revocation (Phase 11)
// ============================================
//
// MCP tokens (server/mcpTokens.ts) are stateless short-lived JWTs; the ONLY
// server-side state for them is this revoked-jti list. A token is honoured by
// the gateway (P12) until its short `exp` OR until its `jti` lands here. We
// keep `exp` per row so expired rows can be GC'd — once a jti's token has
// expired the row is pure noise (the exp alone rejects the token).

export async function createMcpRevocationTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS mcp_revoked_tokens (
      jti VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      exp BIGINT NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT
    )
  `);
  // Index for the GC sweep (delete WHERE exp < cutoff).
  await query(`
    CREATE INDEX IF NOT EXISTS idx_mcp_revoked_tokens_exp ON mcp_revoked_tokens(exp)
  `);
}

/**
 * Revoke a single MCP token by jti. Idempotent — revoking an already-revoked
 * jti is a no-op (keeps the original revoked_at). `exp` is the token's own exp
 * (unix seconds) so the row can be GC'd after it.
 * Returns true if a NEW row was inserted (first revoke), false if already present.
 */
export async function revokeMcpJti(
  jti: string,
  userId: string,
  exp: number,
  reason?: string,
): Promise<boolean> {
  const result = await query(
    `INSERT INTO mcp_revoked_tokens (jti, user_id, exp, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, userId, exp, reason ?? null]
  );
  return (result.rowCount || 0) > 0;
}

/** True if `jti` is in the revocation list. */
export async function isMcpJtiRevoked(jti: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM mcp_revoked_tokens WHERE jti = $1) AS exists',
    [jti]
  );
  return result.rows[0]?.exists === true;
}

/**
 * List currently-revoked (still-unexpired) jtis the gateway should reject.
 * Filters out rows whose token has already expired (those are rejected by exp
 * alone), so the gateway's cached set stays small. `nowSeconds` lets tests pin
 * the clock.
 */
export async function listRevokedMcpJtis(nowSeconds?: number): Promise<string[]> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const result = await query<{ jti: string }>(
    'SELECT jti FROM mcp_revoked_tokens WHERE exp >= $1 ORDER BY revoked_at DESC',
    [now]
  );
  return result.rows.map((r) => r.jti);
}

/**
 * GC revocation rows whose token expired more than `graceSeconds` ago (default
 * 600s past exp, comfortably beyond any clock skew + gateway cache TTL).
 * Returns the number of rows removed.
 */
export async function gcExpiredMcpRevocations(graceSeconds = 600, nowSeconds?: number): Promise<number> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const cutoff = now - graceSeconds;
  const result = await query('DELETE FROM mcp_revoked_tokens WHERE exp < $1', [cutoff]);
  return result.rowCount || 0;
}

// ============================================
// MCP grant store (Phase 15a)
// ============================================
//
// A "grant" lets a user hand a PAIRED MCP (AI) connection scoped access to their
// REAL files. Each grant row holds a per-file `ShareToken` (the JSON whose
// path_scope/permissions/expiry/id are PLAINTEXT; only the DEK inside is
// HPKE-sealed to the MCP's X25519 pubkey, so storing it server-side is safe —
// only the MCP secret can unwrap it). FxFiles publishes a batch (one token per
// file in a folder/tag) under the user's id, bound to a connection pubkey
// (`mcp_pub_b64`). The stateless MCP later GETs ITS grants and merges them.
//
// SECURITY BOUNDARY: grants are fetched ONLY by (user_id, mcp_pub_b64), where
// the pubkey comes from the VERIFIED token `cnf` claim — see app.ts GET
// /api/mcp/grants. This prevents agent A from enumerating agent B's granted
// paths (a cross-agent metadata leak). `permissions` here are REAL-file ops
// {can_read,can_write,can_delete} — distinct from the JWT `mcp` scope perms.

export interface McpGrantRow {
  id: string;
  scope: string;
  permissions: { can_read: boolean; can_write: boolean; can_delete: boolean };
  token_json: string;
  expires_at: number | null;
}

/** A grant to insert (id is generated server-side; user_id/pubkey passed separately). */
export interface McpGrantInput {
  scope: string;
  permissions: { can_read: boolean; can_write: boolean; can_delete: boolean };
  token_json: string;
  expires_at?: number | null;
}

export async function createMcpGrantsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS mcp_grants (
      id UUID PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      mcp_pub_b64 VARCHAR(64) NOT NULL,
      scope TEXT NOT NULL,
      permissions JSONB NOT NULL,
      token_json TEXT NOT NULL,
      expires_at BIGINT,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The hot path is listActiveGrantsForConnection(user_id, mcp_pub_b64) — index it.
  await query(`
    CREATE INDEX IF NOT EXISTS idx_mcp_grants_conn
      ON mcp_grants(user_id, mcp_pub_b64)
  `);
  // GC sweep filters by expires_at.
  await query(`
    CREATE INDEX IF NOT EXISTS idx_mcp_grants_expires ON mcp_grants(expires_at)
  `);
}

/**
 * Bulk-insert grant rows for one (userId, mcpPubB64) connection. Each row gets a
 * fresh UUID (generated in JS so we don't depend on pgcrypto). Returns the
 * created ids (so the caller/user can later revoke by id). Uses a single
 * multi-row INSERT for folder-scale efficiency. Caller is responsible for
 * shape-validation + the per-request cap (see app.ts validateGrantsPayload).
 */
export async function insertMcpGrants(
  userId: string,
  mcpPubB64: string,
  grants: McpGrantInput[],
): Promise<string[]> {
  if (grants.length === 0) return [];
  const { v4: uuidv4 } = await import('uuid');

  const ids: string[] = [];
  const values: unknown[] = [];
  const placeholders: string[] = [];
  // 7 bound columns per row: id, user_id, mcp_pub_b64, scope, permissions, token_json, expires_at.
  grants.forEach((g, i) => {
    const id = uuidv4();
    ids.push(id);
    const base = i * 7;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
    );
    values.push(
      id,
      userId,
      mcpPubB64,
      g.scope,
      JSON.stringify(g.permissions),
      g.token_json,
      g.expires_at ?? null,
    );
  });

  await query(
    `INSERT INTO mcp_grants
       (id, user_id, mcp_pub_b64, scope, permissions, token_json, expires_at)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
  return ids;
}

/**
 * THE SECURITY-CRITICAL READ. List the active (not revoked, not expired) grants
 * for exactly ONE connection: (userId, mcpPubB64). Both arguments MUST come from
 * the VERIFIED MCP-JWT (sub + cnf.mcp_pub_b64) — never from a request param or
 * header — so one agent cannot read another's grants. `nowSeconds` lets tests
 * pin the clock. Never returns token rows for any other connection.
 */
export async function listActiveGrantsForConnection(
  userId: string,
  mcpPubB64: string,
  nowSeconds?: number,
): Promise<McpGrantRow[]> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const result = await query<{
    id: string;
    scope: string;
    permissions: { can_read: boolean; can_write: boolean; can_delete: boolean };
    token_json: string;
    expires_at: string | number | null;
  }>(
    `SELECT id, scope, permissions, token_json, expires_at
       FROM mcp_grants
      WHERE user_id = $1
        AND mcp_pub_b64 = $2
        AND NOT revoked
        AND (expires_at IS NULL OR expires_at > $3)
      ORDER BY created_at ASC`,
    [userId, mcpPubB64, now],
  );
  return result.rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    permissions: r.permissions,
    token_json: r.token_json,
    // pg returns BIGINT as string; normalize to number|null.
    expires_at: r.expires_at == null ? null : Number(r.expires_at),
  }));
}

/**
 * Revoke grants for a user. Two scoping modes (the caller picks ONE):
 *   - by `id`: revoke that single grant row.
 *   - by `(mcpPubB64, scope)`: revoke all rows matching that connection+scope
 *     (e.g. "stop sharing this folder with this agent").
 * Always also constrained by `user_id = $1` so a user can only revoke THEIR OWN
 * grants. Idempotent (re-revoking an already-revoked row is a no-op). Returns
 * the number of rows newly affected.
 */
export async function revokeMcpGrant(
  userId: string,
  target: { id: string } | { mcpPubB64: string; scope: string },
): Promise<number> {
  let result;
  if ('id' in target) {
    result = await query(
      'UPDATE mcp_grants SET revoked = TRUE WHERE user_id = $1 AND id = $2 AND NOT revoked',
      [userId, target.id],
    );
  } else {
    result = await query(
      'UPDATE mcp_grants SET revoked = TRUE WHERE user_id = $1 AND mcp_pub_b64 = $2 AND scope = $3 AND NOT revoked',
      [userId, target.mcpPubB64, target.scope],
    );
  }
  return result.rowCount || 0;
}

/**
 * GC grant rows that expired more than `graceSeconds` ago (default 600s).
 * Revoked rows are kept until their token would have expired too (so a revoked
 * grant with no expiry is retained — harmless, and preserves an audit trail);
 * an explicit sweep of revoked rows can be added later if volume warrants.
 * Returns the number of rows removed.
 */
export async function gcExpiredGrants(graceSeconds = 600, nowSeconds?: number): Promise<number> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const cutoff = now - graceSeconds;
  const result = await query(
    'DELETE FROM mcp_grants WHERE expires_at IS NOT NULL AND expires_at < $1',
    [cutoff],
  );
  return result.rowCount || 0;
}

// ============================================
// MCP connection registry (connection lifecycle)
// ============================================
//
// A "connection" is a paired MCP (AI) client, identified by its X25519 pubkey
// (`mcp_pub_b64`). Unlike the stateless MCP JWTs, a connection is LONG-LIVED
// server-side state: it stores a high-entropy REFRESH TOKEN (only its sha256
// hash is persisted) plus the connection's FROZEN scope claim. The refresh
// token lets the client re-mint THIS connection's short-lived workspace JWT
// (bucket fula-ai-workspace, prefix ai/, the SAME perms captured at pairing)
// WITHOUT re-pairing — closing the "1h token, no renew → re-pair" blocker.
//
// SECURITY INVARIANT: a refresh re-mints ONLY from `scope` stored here (never a
// request-supplied scope), so a connection paired with narrow perms can never
// widen on refresh, and the refresh token can never yield the user's broader
// account credential. The pubkey + scope are captured at MINT time from the
// resolved claims; the refresh path reads them back verbatim.
//
// There is deliberately NO `exp` column: a connection lives until the user (or
// an admin) revokes it. Revocation flips `revoked = true`; the gateway polls
// listRevokedConnectionPubkeys() to deny a revoked connection's JWT by its
// `cnf` (mcp_pub_b64) binding before the JWT's own short exp.

/** The stored mcp scope claim shape (mirror of McpScopeClaim, kept local to avoid a cross-module type dep). */
export interface McpConnectionScope {
  v: number;
  scopes: Array<{ bucket: string; prefix: string; perms: string[] }>;
  /**
   * ADDITIVE (collab-write auth): the collab groups this connection is
   * authorized to WRITE to via a `collab_write` token. Populated ONLY by the
   * authorize endpoint (POST /api/mcp/connections/:id/collab-groups); the
   * `mcp_s3` minting path ignores it entirely. Absent ⇒ no collab authorization
   * (backward-compatible — existing rows have no `collab` key).
   */
  collab?: { groupIds: string[] };
}

export interface McpConnectionRow {
  id: string;
  user_id: string;
  mcp_pub_b64: string;
  label: string | null;
  scope: McpConnectionScope;
  revoked: boolean;
  created_at: string;
  last_refreshed_at: string | null;
}

/** Fields needed to insert a connection (id/created_at default server-side). */
export interface McpConnectionInput {
  id: string;
  userId: string;
  mcpPubB64: string;
  label?: string | null;
  refreshTokenHash: string; // sha256 HEX (64 chars) of the high-entropy refresh token
  scope: McpConnectionScope;
}

export async function createMcpConnectionsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS mcp_connections (
      id UUID PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      mcp_pub_b64 VARCHAR(64) NOT NULL,
      label TEXT,
      refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
      scope JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      last_refreshed_at TIMESTAMPTZ
    )
  `);
  // The user-facing list path filters by user_id.
  await query(`
    CREATE INDEX IF NOT EXISTS idx_mcp_connections_user ON mcp_connections(user_id)
  `);
  // The refresh path looks up by refresh_token_hash; the UNIQUE constraint above
  // already creates a backing index, so no separate index is needed.
}

/**
 * Insert a new connection row. Returns the generated id (passed in by the
 * caller so it can be echoed in the mint response). The refresh token itself is
 * NEVER stored — only `refreshTokenHash` (sha256 hex). Repeated pairings of the
 * same pubkey intentionally create distinct rows (each with its own revocable
 * refresh token) — that's re-pairing, not an upsert.
 */
export async function insertMcpConnection(row: McpConnectionInput): Promise<string> {
  await query(
    `INSERT INTO mcp_connections (id, user_id, mcp_pub_b64, label, refresh_token_hash, scope)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.id,
      row.userId,
      row.mcpPubB64,
      row.label ?? null,
      row.refreshTokenHash,
      JSON.stringify(row.scope),
    ],
  );
  return row.id;
}

/**
 * Look up a connection by the sha256 HEX of its refresh token. Returns the row
 * (including its FROZEN scope) or null. The caller must still check `revoked`.
 * The lookup is by the UNIQUE hash of a 256-bit secret, so it is not a guessable
 * key; we compare the full hash via SQL equality (the hash is not itself a
 * secret that benefits from constant-time compare — a DB read already discloses
 * it, and brute-forcing a 256-bit token is infeasible).
 */
export async function findMcpConnectionByRefreshHash(
  refreshTokenHash: string,
): Promise<McpConnectionRow | null> {
  const result = await query<McpConnectionRow>(
    `SELECT id, user_id, mcp_pub_b64, label, scope, revoked, created_at, last_refreshed_at
       FROM mcp_connections
      WHERE refresh_token_hash = $1`,
    [refreshTokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Mark a refresh as having just happened (bumps last_refreshed_at to NOW()).
 * Best-effort — a failure here must not fail the already-minted token, so the
 * caller should not await-throw on it in a way that loses the token.
 */
export async function touchMcpConnectionRefreshed(id: string): Promise<void> {
  await query('UPDATE mcp_connections SET last_refreshed_at = NOW() WHERE id = $1', [id]);
}

/**
 * Revoke a connection — user-scoped: a user can only revoke THEIR OWN
 * connection. Idempotent (re-revoking is a no-op). Returns true if a row was
 * newly revoked, false if it didn't exist for this user or was already revoked.
 */
export async function revokeMcpConnection(userId: string, id: string): Promise<boolean> {
  const result = await query(
    'UPDATE mcp_connections SET revoked = TRUE WHERE user_id = $1 AND id = $2 AND NOT revoked',
    [userId, id],
  );
  return (result.rowCount || 0) > 0;
}

/**
 * List a user's connections for the management UI. NEVER returns the refresh
 * token or its hash — only safe, displayable metadata.
 */
export async function listMcpConnectionsForUser(userId: string): Promise<
  Array<{
    id: string;
    label: string | null;
    mcp_pub_b64: string;
    created_at: string;
    revoked: boolean;
    last_refreshed_at: string | null;
  }>
> {
  const result = await query<{
    id: string;
    label: string | null;
    mcp_pub_b64: string;
    created_at: string;
    revoked: boolean;
    last_refreshed_at: string | null;
  }>(
    `SELECT id, label, mcp_pub_b64, created_at, revoked, last_refreshed_at
       FROM mcp_connections
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

/**
 * The gateway-pollable feed: the pubkeys of currently-revoked connections. The
 * gateway denies any MCP JWT whose `cnf.mcp_pub_b64` is in this set (until the
 * JWT's own short exp catches up). Connections have no exp, so the filter is
 * simply `revoked = true`. DISTINCT collapses multiple revoked rows that share a
 * pubkey (re-pairing history).
 */
export async function listRevokedConnectionPubkeys(): Promise<string[]> {
  const result = await query<{ mcp_pub_b64: string }>(
    'SELECT DISTINCT mcp_pub_b64 FROM mcp_connections WHERE revoked = TRUE',
  );
  return result.rows.map((r) => r.mcp_pub_b64);
}

/**
 * Load a single connection row by id (NOT user-scoped — callers that need
 * ownership must check `user_id` themselves). Used by the collab-write path to
 * resolve the connection a `collab_write` token names in `collab.cid` for the
 * SYNCHRONOUS revoked check, and by the authorize endpoint.
 */
export async function findMcpConnectionById(id: string): Promise<McpConnectionRow | null> {
  const result = await query<McpConnectionRow>(
    `SELECT id, user_id, mcp_pub_b64, label, scope, revoked, created_at, last_refreshed_at
       FROM mcp_connections
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Authorize (MERGE-add) collab group ids onto a connection's stored scope.
 * USER-SCOPED + not-revoked: the row must belong to `userId` and be live, or
 * this returns null (the endpoint maps that to 404/403). The merge + write are
 * done in JS for clarity; the UPDATE re-asserts `user_id = $ AND NOT revoked`
 * so a connection revoked between the load and the write is never modified
 * (rowCount 0 → null). Returns the AUTHORITATIVE post-update row (so the minted
 * token reflects exactly what is stored). `addGroupIds` are assumed already
 * UUID-validated + lowercased by the caller (collabTokens.normalizeGroupIds).
 */
export async function authorizeCollabGroupsForConnection(
  userId: string,
  id: string,
  addGroupIds: string[],
): Promise<McpConnectionRow | null> {
  const row = await findMcpConnectionById(id);
  if (!row || row.user_id !== userId || row.revoked) return null;

  const existing = Array.isArray(row.scope?.collab?.groupIds) ? row.scope.collab!.groupIds : [];
  // EXACT (case-sensitive) merge — a group's identity is its exact id (the
  // collab_manifests PK); see collabTokens.normalizeGroupIds.
  const merged = [...new Set([...existing.map(String), ...addGroupIds.map(String)])];
  const newScope: McpConnectionScope = { ...row.scope, collab: { groupIds: merged } };

  const upd = await query<{ scope: McpConnectionScope }>(
    `UPDATE mcp_connections SET scope = $1
       WHERE id = $2 AND user_id = $3 AND NOT revoked
       RETURNING scope`,
    [JSON.stringify(newScope), id, userId],
  );
  if ((upd.rowCount || 0) === 0) return null; // revoked/gone between load and write
  row.scope = upd.rows[0].scope;
  return row;
}

/**
 * De-authorize (REMOVE) collab group ids from a connection's stored scope.
 * USER-SCOPED (the row must belong to `userId`). Unlike the add path this is
 * allowed even on a revoked row (removing access is always safe). Returns the
 * authoritative post-update row, or null if the row doesn't exist for this user.
 * Combined with the synchronous DB-truth check on the write path, a removed
 * group is denied IMMEDIATELY (not after token TTL). `removeGroupIds` are
 * lowercased by the caller.
 */
export async function deauthorizeCollabGroupsForConnection(
  userId: string,
  id: string,
  removeGroupIds: string[],
): Promise<McpConnectionRow | null> {
  const row = await findMcpConnectionById(id);
  if (!row || row.user_id !== userId) return null;

  const remove = new Set(removeGroupIds.map(String));
  const existing = Array.isArray(row.scope?.collab?.groupIds) ? row.scope.collab!.groupIds : [];
  const kept = existing.map(String).filter((g) => !remove.has(g));
  const newScope: McpConnectionScope = { ...row.scope, collab: { groupIds: kept } };

  const upd = await query<{ scope: McpConnectionScope }>(
    `UPDATE mcp_connections SET scope = $1 WHERE id = $2 AND user_id = $3 RETURNING scope`,
    [JSON.stringify(newScope), id, userId],
  );
  if ((upd.rowCount || 0) === 0) return null;
  row.scope = upd.rows[0].scope;
  return row;
}

/**
 * Which of `groupIds` have a `collab_manifests` row (i.e. are REAL, known
 * groups). Used by the authorize endpoint to reject authorizing a connection
 * for a group that does not exist (you can only delegate access to a group you
 * can name — the groupId UUID is the link-authorization capability). Returns the
 * set of EXISTING ids (lowercased). The caller diffs against the requested set.
 */
export async function collabGroupsExist(groupIds: string[]): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  // EXACT match — a group's identity is its exact group_id (the PK); matching
  // case-insensitively here would let an authorization bind to a different
  // stored group than the one written to. See collabTokens.normalizeGroupIds.
  const result = await query<{ group_id: string }>(
    'SELECT group_id FROM collab_manifests WHERE group_id = ANY($1::text[])',
    [groupIds],
  );
  return new Set(result.rows.map((r) => String(r.group_id)));
}

// ============================================
// Collab-write auth — manifest flags + version + audit (additive)
// ============================================

/**
 * Create the base `collab_manifests` table + its historical migrations (encrypted
 * column, nullable manifest_data, creator_id). Extracted so both the app init
 * and the tests build an identical schema. The additive collab-write-auth
 * columns/tables are added by `createCollabWriteAuthSchema` (call it after).
 */
export async function createCollabManifestsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS collab_manifests (
      group_id TEXT PRIMARY KEY,
      manifest_data TEXT,
      encrypted_manifest TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE collab_manifests ADD COLUMN IF NOT EXISTS encrypted_manifest TEXT`).catch(() => {});
  await query(`ALTER TABLE collab_manifests ALTER COLUMN manifest_data DROP NOT NULL`).catch(() => {});
  await query(`ALTER TABLE collab_manifests ADD COLUMN IF NOT EXISTS creator_id VARCHAR(64)`).catch(() => {});
}

/**
 * Additive schema for the collab-write auth feature:
 *  • collab_manifests.collab_writes_revoked — the per-group AI-write KILL SWITCH
 *    (server source of truth, checked synchronously on every collab write —
 *    NOT the manifest blob). Default FALSE ⇒ existing groups unaffected.
 *  • collab_manifests.manifest_version — monotonic version for OPT-IN CAS on
 *    PUT manifest-sync. Default 0 ⇒ existing groups start at 0; the first
 *    versioned write moves it to 1.
 *  • collab_audit_log — one row per collab write (human OR AI).
 * Idempotent (IF NOT EXISTS) and safe to run on every boot.
 */
export async function createCollabWriteAuthSchema(): Promise<void> {
  await query(
    `ALTER TABLE collab_manifests ADD COLUMN IF NOT EXISTS collab_writes_revoked BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await query(
    `ALTER TABLE collab_manifests ADD COLUMN IF NOT EXISTS manifest_version BIGINT NOT NULL DEFAULT 0`,
  );
  await query(`
    CREATE TABLE IF NOT EXISTS collab_audit_log (
      id BIGSERIAL PRIMARY KEY,
      principal_id VARCHAR(64) NOT NULL,
      principal_type VARCHAR(16) NOT NULL,
      group_id TEXT NOT NULL,
      verb VARCHAR(32) NOT NULL,
      file_id TEXT,
      src_ip VARCHAR(64),
      status_code INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // status_code is additive for forensics; add it if an older table predates it.
  await query(`ALTER TABLE collab_audit_log ADD COLUMN IF NOT EXISTS status_code INT`);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_collab_audit_group ON collab_audit_log(group_id, created_at)`,
  );
}

/**
 * True iff the group's AI/collab writes are revoked (the kill switch). A MISSING
 * row ⇒ false (nothing to revoke; the write then resolves the creator key as
 * usual). Throws on a real query error so the caller can FAIL CLOSED (deny) —
 * never swallow into a false.
 */
export async function isCollabGroupWritesRevoked(groupId: string): Promise<boolean> {
  const result = await query<{ collab_writes_revoked: boolean }>(
    'SELECT collab_writes_revoked FROM collab_manifests WHERE group_id = $1',
    [groupId],
  );
  return result.rows[0]?.collab_writes_revoked === true;
}

/**
 * Flip the per-group AI-write kill switch. CREATOR-GATED: only the group's
 * `creator_id` may toggle it (the collab files live in the creator's S3
 * namespace, so the creator is the authority). Returns:
 *   'not_found' — no manifest row for the group
 *   'forbidden' — creator_id is null OR != caller (don't disclose which)
 *   'ok'        — flipped
 */
export async function setCollabWritesRevoked(
  groupId: string,
  callerId: string,
  revoked: boolean,
): Promise<'ok' | 'not_found' | 'forbidden'> {
  const row = await query<{ creator_id: string | null }>(
    'SELECT creator_id FROM collab_manifests WHERE group_id = $1',
    [groupId],
  );
  if (row.rows.length === 0) return 'not_found';
  const creatorId = row.rows[0].creator_id;
  if (!creatorId || creatorId !== callerId) return 'forbidden';
  await query(
    'UPDATE collab_manifests SET collab_writes_revoked = $2, updated_at = NOW() WHERE group_id = $1',
    [groupId, revoked],
  );
  return 'ok';
}

export interface CollabManifestSyncResult {
  /** false ⇒ CAS conflict (the stored version moved); `version` is the CURRENT stored version. */
  ok: boolean;
  /** new version on success, or the current stored version on a CAS conflict. */
  version: number;
}

/**
 * Manifest-sync upsert with OPTIONAL conditional write (CAS). Preserves the
 * EXACT column semantics of the original two-path upsert (encrypted vs legacy
 * plaintext) and ADDS:
 *   • manifest_version = manifest_version + 1 on every update (1 on insert)
 *   • a CAS guard: `WHERE $base IS NULL OR manifest_version = $base`
 *
 * `baseVersion == null/undefined` ⇒ NO CAS (always writes — identical to the
 * legacy behavior, just now also bumping the version). When a base IS given and
 * the stored version differs, the ON CONFLICT update's WHERE excludes the row →
 * 0 rows returned → we report `{ ok: false, version: <current> }` so the route
 * can 409. Atomic + race-free: Postgres takes a row lock on the conflicting row
 * for ON CONFLICT DO UPDATE, so two writers with the same base serialize — the
 * first bumps the version, the second's WHERE (= old base) then fails.
 *
 * Brand-new group (no row) + a base given ⇒ the INSERT path runs (no conflict),
 * creating it at version 1 (CAS does not apply to creation; documented).
 */
export async function syncCollabManifest(
  groupId: string,
  opts: {
    encryptedManifest?: string | null;
    data?: string | null;
    creatorId: string | null;
    baseVersion?: number | null;
  },
): Promise<CollabManifestSyncResult> {
  const base = opts.baseVersion == null ? null : opts.baseVersion;
  const useEncrypted = typeof opts.encryptedManifest === 'string' && opts.encryptedManifest.length > 0;

  let result;
  if (useEncrypted) {
    result = await query<{ manifest_version: string | number }>(
      `INSERT INTO collab_manifests (group_id, manifest_data, encrypted_manifest, creator_id, manifest_version, updated_at)
       VALUES ($1, NULL, $2, $3, 1, NOW())
       ON CONFLICT (group_id) DO UPDATE SET
         encrypted_manifest = EXCLUDED.encrypted_manifest,
         manifest_data = NULL,
         creator_id = COALESCE(collab_manifests.creator_id, EXCLUDED.creator_id),
         manifest_version = collab_manifests.manifest_version + 1,
         updated_at = NOW()
       WHERE $4::bigint IS NULL OR collab_manifests.manifest_version = $4::bigint
       RETURNING manifest_version`,
      [groupId, opts.encryptedManifest, opts.creatorId, base],
    );
  } else {
    result = await query<{ manifest_version: string | number }>(
      `INSERT INTO collab_manifests (group_id, manifest_data, creator_id, manifest_version, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (group_id) DO UPDATE SET
         manifest_data = EXCLUDED.manifest_data,
         creator_id = COALESCE(collab_manifests.creator_id, EXCLUDED.creator_id),
         manifest_version = collab_manifests.manifest_version + 1,
         updated_at = NOW()
       WHERE $4::bigint IS NULL OR collab_manifests.manifest_version = $4::bigint
       RETURNING manifest_version`,
      [groupId, opts.data ?? null, opts.creatorId, base],
    );
  }

  if (result.rows.length > 0) {
    return { ok: true, version: Number(result.rows[0].manifest_version) };
  }
  // No row returned ⇒ CAS conflict (row exists, version != base). Report current.
  const cur = await query<{ manifest_version: string | number }>(
    'SELECT manifest_version FROM collab_manifests WHERE group_id = $1',
    [groupId],
  );
  const currentVersion = cur.rows.length > 0 ? Number(cur.rows[0].manifest_version) : 0;
  return { ok: false, version: currentVersion };
}

/** Best-effort audit row for a collab write (human OR AI). Never throws to the caller. */
export async function insertCollabAuditLog(entry: {
  principalId: string;
  principalType: 'connection' | 'user';
  groupId: string;
  verb: string;
  fileId?: string | null;
  srcIp?: string | null;
  statusCode?: number | null;
}): Promise<void> {
  await query(
    `INSERT INTO collab_audit_log (principal_id, principal_type, group_id, verb, file_id, src_ip, status_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.principalId,
      entry.principalType,
      entry.groupId,
      entry.verb,
      entry.fileId ?? null,
      entry.srcIp ?? null,
      entry.statusCode ?? null,
    ],
  );
}

export default {
  createPostgresPool,
  getPool,
  query,
  getClient,
  closePool,
  isPostgresConfigured,
  verifyConnection,
  emailToUserId,
  getOrCreateWebuiUser,
  getWebuiUserById,
  getWebuiUserByEmail,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  getUserPins,
  getUserStats,
  deleteUserProfile,
  addPin,
  getReferralCode,
  getReferralStats,
  getUserReferralCodes,
  createUserReferralCode,
  updateReferralCodeName,
  deleteUserReferralCode,
  verifyApiKey,
  getChainSyncState,
  updateChainSyncState,
  markAppDownloaded,
  getUserCompany,
  updateUserCompany,
  encryptApiKey,
  decryptApiKey,
  createMcpRevocationTable,
  revokeMcpJti,
  isMcpJtiRevoked,
  listRevokedMcpJtis,
  gcExpiredMcpRevocations,
  createMcpGrantsTable,
  insertMcpGrants,
  listActiveGrantsForConnection,
  revokeMcpGrant,
  gcExpiredGrants,
  createMcpConnectionsTable,
  insertMcpConnection,
  findMcpConnectionByRefreshHash,
  touchMcpConnectionRefreshed,
  revokeMcpConnection,
  listMcpConnectionsForUser,
  listRevokedConnectionPubkeys,
};
