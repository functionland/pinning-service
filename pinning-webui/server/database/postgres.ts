/**
 * PostgreSQL Database Module for Pinning WebUI
 *
 * This module provides PostgreSQL connectivity for the pinning-webui.
 * All operations are async and use connection pooling.
 */

import pg, { QueryResultRow } from 'pg';
const { Pool } = pg;

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

// Get or create webui user
export async function getOrCreateWebuiUser(
  email: string,
  name: string,
  picture: string,
  jwtSecret: string,
  generateJwtApiKey: (email: string, jwtSecret: string) => string,
  referralCode?: string
): Promise<{ email: string; name: string; picture: string; isNew: boolean }> {
  const existing = await query<any>(
    'SELECT * FROM webui_users WHERE email = $1',
    [email]
  );

  if (existing.rows[0]) {
    await query(
      'UPDATE webui_users SET last_login_at = NOW(), name = $1, picture = $2 WHERE email = $3',
      [name, picture, email]
    );
    return { ...existing.rows[0], isNew: false };
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

  // Insert new user with company pre-filled from referral link name
  await query(
    'INSERT INTO webui_users (email, name, picture, last_login_at, company) VALUES ($1, $2, $3, NOW(), $4)',
    [email, name, picture, inheritedName]
  );

  // Create first API key automatically
  const keyId = generateJwtApiKey(email, jwtSecret);
  await query('INSERT INTO api_keys (key_id, user_email) VALUES ($1, $2)', [keyId, email]);

  // Also create entry in main users/sessions tables for pinning service compatibility
  const existingMainUser = await query('SELECT * FROM users WHERE username = $1', [email]);
  if (!existingMainUser.rows[0]) {
    const { v4: uuidv4 } = await import('uuid');
    await query(
      'INSERT INTO users (username, password_hash, pool_id) VALUES ($1, $2, 1)',
      [email, 'google-oauth-user-' + uuidv4()]
    );
  }

  // Create session token that matches the API key
  await query(
    `INSERT INTO sessions (session_token, username, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (session_token) DO UPDATE SET username = $2, created_at = NOW()`,
    [keyId, email]
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

  // Insert with is_default and inherited_name
  await query(
    'INSERT INTO referral_codes (user_email, code, is_default, inherited_name) VALUES ($1, $2, TRUE, $3)',
    [email, newReferralCode, inheritedName]
  );

  // If referred by someone, create referral record
  if (referralCode) {
    const referrer = await query<{ user_email: string }>(
      'SELECT user_email FROM referral_codes WHERE code = $1',
      [referralCode]
    );
    // Prevent self-referral and only link if referrer exists
    if (referrer.rows[0] && referrer.rows[0].user_email !== email) {
      await query(
        'INSERT INTO referrals (referrer_email, referred_email, referral_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [referrer.rows[0].user_email, email, referralCode]
      );
    }
  }

  return { email, name, picture, isNew: true };
}

// Get user by email
export async function getWebuiUserByEmail(email: string): Promise<any> {
  const result = await query('SELECT * FROM webui_users WHERE email = $1', [email]);
  return result.rows[0];
}

// Get API keys
export async function getApiKeys(email: string): Promise<any[]> {
  const result = await query(
    'SELECT key_id, created_at, last_used_at FROM api_keys WHERE user_email = $1 AND is_deleted = 0 ORDER BY created_at DESC',
    [email]
  );
  return result.rows;
}

// Create API key
export async function createApiKey(
  email: string,
  jwtSecret: string,
  generateJwtApiKey: (email: string, jwtSecret: string) => string
): Promise<string> {
  const keyId = generateJwtApiKey(email, jwtSecret);
  await query('INSERT INTO api_keys (key_id, user_email) VALUES ($1, $2)', [keyId, email]);

  // Also create corresponding session for pinning service
  await query(
    `INSERT INTO sessions (session_token, username, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (session_token) DO UPDATE SET username = $2, created_at = NOW()`,
    [keyId, email]
  );

  return keyId;
}

// Delete API key
export async function deleteApiKey(email: string, keyId: string): Promise<boolean> {
  const result = await query(
    'UPDATE api_keys SET is_deleted = 1, deleted_at = NOW() WHERE user_email = $1 AND key_id = $2 AND is_deleted = 0',
    [email, keyId]
  );

  // Remove from sessions table
  await query('DELETE FROM sessions WHERE session_token = $1 AND username = $2', [keyId, email]);

  return (result.rowCount || 0) > 0;
}

// Get user pins
export async function getUserPins(
  email: string,
  page: number,
  limit: number,
  search?: string
): Promise<{ pins: any[]; total: number }> {
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE username = $1 AND status != \'deleted\'';
  const params: any[] = [email];
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
export async function getUserStats(email: string): Promise<{
  totalPins: number;
  totalSize: number;
  lastLogin: string;
  memberSince: string;
}> {
  const statsResult = await query(
    `SELECT COUNT(*) as total_pins, COALESCE(SUM(size), 0) as total_size
     FROM pins
     WHERE username = $1 AND status != 'deleted'`,
    [email]
  );

  const userResult = await query(
    'SELECT last_login_at, created_at FROM webui_users WHERE email = $1',
    [email]
  );

  return {
    totalPins: parseInt(statsResult.rows[0]?.total_pins || '0', 10),
    totalSize: parseInt(statsResult.rows[0]?.total_size || '0', 10),
    lastLogin: userResult.rows[0]?.last_login_at,
    memberSince: userResult.rows[0]?.created_at,
  };
}

// Delete user profile
export async function deleteUserProfile(email: string): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pins WHERE username = $1', [email]);
    await client.query('DELETE FROM users WHERE username = $1', [email]);
    await client.query('DELETE FROM sessions WHERE username = $1', [email]);
    await client.query('DELETE FROM api_keys WHERE user_email = $1', [email]);
    await client.query('DELETE FROM webui_users WHERE email = $1', [email]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Add pin
export async function addPin(email: string, cid: string, name?: string): Promise<string> {
  const { v4: uuidv4 } = await import('uuid');
  const requestId = uuidv4();
  const nameLower = (name || '').toLowerCase();

  await query(
    `INSERT INTO pins (requestid, username, cid, name, name_lowercase, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), NOW())`,
    [requestId, email, cid, name || '', nameLower]
  );

  return requestId;
}

// ============================================
// Referral System Operations
// ============================================

export async function getReferralCode(email: string): Promise<string | null> {
  const result = await query<{ code: string }>(
    'SELECT code FROM referral_codes WHERE user_email = $1',
    [email]
  );
  return result.rows[0]?.code || null;
}

export async function getReferralStats(email: string): Promise<{
  totalReferred: number;
  referrals: Array<{ email: string; referredAt: string }>;
}> {
  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM referrals WHERE referrer_email = $1',
    [email]
  );

  const referralsResult = await query<{ referred_email: string; referred_at: string }>(
    'SELECT referred_email, referred_at FROM referrals WHERE referrer_email = $1 ORDER BY referred_at DESC LIMIT 50',
    [email]
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

export async function getUserReferralCodes(email: string): Promise<ReferralCodeInfo[]> {
  const result = await query<{
    code: string;
    name: string | null;
    inherited_name: string | null;
    is_default: boolean;
    created_at: string;
  }>(
    `SELECT code, name, inherited_name, is_default, created_at
     FROM referral_codes
     WHERE user_email = $1
     ORDER BY is_default DESC, created_at ASC`,
    [email]
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
  email: string,
  name: string | null
): Promise<{ code: string; error?: string }> {
  // Check max codes limit (10 per user)
  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM referral_codes WHERE user_email = $1',
    [email]
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
    'INSERT INTO referral_codes (user_email, code, name, is_default) VALUES ($1, $2, $3, FALSE)',
    [email, newCode, truncatedName]
  );

  return { code: newCode };
}

// Update a referral code's name
export async function updateReferralCodeName(
  email: string,
  code: string,
  name: string | null
): Promise<{ success: boolean; error?: string }> {
  // Truncate name to 50 chars if provided
  const truncatedName = name ? name.substring(0, 50) : null;

  const result = await query(
    'UPDATE referral_codes SET name = $1 WHERE user_email = $2 AND code = $3',
    [truncatedName, email, code]
  );

  if ((result.rowCount || 0) === 0) {
    return { success: false, error: 'Referral code not found' };
  }

  return { success: true };
}

// Delete a referral code
export async function deleteUserReferralCode(
  email: string,
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
    'SELECT COUNT(*) as count FROM referral_codes WHERE user_email = $1',
    [email]
  );
  const totalCodes = parseInt(countResult.rows[0]?.count || '0', 10);
  if (totalCodes <= 1) {
    return { success: false, error: 'Cannot delete your only referral code' };
  }

  // Check if this is the default code
  const codeInfo = await query<{ is_default: boolean }>(
    'SELECT is_default FROM referral_codes WHERE user_email = $1 AND code = $2',
    [email, code]
  );
  if (codeInfo.rows[0]?.is_default) {
    return { success: false, error: 'Cannot delete the default referral code' };
  }

  const result = await query(
    'DELETE FROM referral_codes WHERE user_email = $1 AND code = $2',
    [email, code]
  );

  if ((result.rowCount || 0) === 0) {
    return { success: false, error: 'Referral code not found' };
  }

  return { success: true };
}

// ============================================
// API Key Verification
// ============================================

export async function verifyApiKey(keyId: string): Promise<string | null> {
  const result = await query<{ user_email: string }>(
    'SELECT user_email FROM api_keys WHERE key_id = $1 AND is_deleted = 0',
    [keyId]
  );

  if (result.rows[0]) {
    // Update last_used_at
    await query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE key_id = $1',
      [keyId]
    );
    return result.rows[0].user_email;
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

export async function markAppDownloaded(email: string): Promise<void> {
  await query(
    'UPDATE webui_users SET app_downloaded = 1, app_downloaded_at = NOW() WHERE email = $1 AND app_downloaded = 0',
    [email]
  );
}

// ============================================
// User Company/Organization
// ============================================

export async function getUserCompany(email: string): Promise<string | null> {
  const result = await query<{ company: string | null }>(
    'SELECT company FROM webui_users WHERE email = $1',
    [email]
  );
  return result.rows[0]?.company || null;
}

export async function updateUserCompany(email: string, company: string | null): Promise<boolean> {
  // Truncate company to 100 chars if provided
  const truncatedCompany = company ? company.substring(0, 100) : null;

  const result = await query(
    'UPDATE webui_users SET company = $1 WHERE email = $2',
    [truncatedCompany, email]
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
  getOrCreateWebuiUser,
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
};
