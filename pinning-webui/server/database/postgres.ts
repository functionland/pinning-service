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
        if (referrer.rows[0] && referrer.rows[0].user_id !== userId) {
          await query(
            'INSERT INTO referrals (referrer_id, referred_id, referral_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [referrer.rows[0].user_id, userId, referralCode]
          );
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
    // Prevent self-referral and only link if referrer exists
    if (referrer.rows[0] && referrer.rows[0].user_id !== userId) {
      await query(
        'INSERT INTO referrals (referrer_id, referred_id, referral_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [referrer.rows[0].user_id, userId, referralCode]
      );
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
  return result.rows.map((row: any) => {
    let displayKey = row.key_id;
    if (row.encrypted_key) {
      try {
        const decrypted = decryptApiKey(row.encrypted_key);
        if (decrypted) displayKey = decrypted;
      } catch { /* fallback to key_id */ }
    }
    return {
      key_id: displayKey,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    };
  });
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
};
