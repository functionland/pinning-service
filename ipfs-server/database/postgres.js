/**
 * PostgreSQL Database Module for IPFS Server
 *
 * This module provides PostgreSQL connectivity for the IPFS server (read-only operations).
 * The ipfs-server only needs to validate sessions and get user pool IDs.
 */

const pg = require('pg');
const crypto = require('crypto');
const { Pool } = pg;

// Pool instance
let pool = null;

// Get configuration from environment
function getPostgresConfig() {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'pinning_service',
    user: process.env.POSTGRES_USER || 'pinning_user',
    password: process.env.POSTGRES_PASSWORD || '',
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 10, // ipfs-server uses read-only, so fewer connections
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

// Create and configure the connection pool
function createPostgresPool() {
  if (pool) {
    return pool;
  }

  const config = getPostgresConfig();
  pool = new Pool(config);

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });

  return pool;
}

// Get the pool instance
function getPool() {
  if (!pool) {
    return createPostgresPool();
  }
  return pool;
}

// Execute a query
async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

// Close the pool
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Check if PostgreSQL is configured
function isPostgresConfigured() {
  return !!process.env.POSTGRES_HOST;
}

// Session validation (read-only) — look up by token_hash, fall back to legacy session_token
async function validateSession(sessionToken) {
  const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
  let result = await query(
    'SELECT username, user_id FROM sessions WHERE token_hash = $1',
    [tokenHash]
  );
  if (result.rows[0]) return result.rows[0];
  // Fallback for old entries that only have plain-text session_token
  result = await query(
    'SELECT username, user_id FROM sessions WHERE session_token = $1',
    [sessionToken]
  );
  return result.rows[0];
}

// Get user pool ID (read-only)
async function getUserPoolId(username) {
  const result = await query(
    'SELECT pool_id FROM users WHERE user_id = $1 OR username = $1',
    [username]
  );
  return result.rows[0];
}

// ---- blocked_cids ----
// normalizeCid is re-exported from ./cid.js so tests can use it without pulling
// in the `pg` module transitively.
const { normalizeCid } = require('./cid.js');

// In-memory policy cache — single SELECT per TTL, per process.
// Map<normalizedCid, 'block' | 'redirect'>
const _blockedCache = { map: new Map(), loadedAt: 0, ttlMs: 60000 };

async function loadBlockedCids(force = false) {
  const now = Date.now();
  if (!force && now - _blockedCache.loadedAt < _blockedCache.ttlMs) {
    return _blockedCache.map;
  }
  const result = await query('SELECT cid, mode FROM blocked_cids', []);
  // Coerce any unexpected stored value to 'block'. The CHECK constraint in
  // migration 016 limits values to {'block','redirect'}, but this stays robust
  // if a future migration widens the column without updating this code.
  _blockedCache.map = new Map(
    result.rows.map(r => [r.cid, r.mode === 'redirect' ? 'redirect' : 'block'])
  );
  _blockedCache.loadedAt = now;
  return _blockedCache.map;
}

// Returns 'block' | 'redirect' for the (caller-normalized) CID, or null if absent.
async function getBlockedCidMode(normalizedCid) {
  const map = await loadBlockedCids(false);
  return map.get(normalizedCid) ?? null;
}

// Backwards-compat: true if the CID is in the policy list under any mode.
async function isBlockedCid(normalizedCid) {
  return (await getBlockedCidMode(normalizedCid)) !== null;
}

module.exports = {
  createPostgresPool,
  getPool,
  query,
  closePool,
  isPostgresConfigured,
  validateSession,
  getUserPoolId,
  normalizeCid,
  isBlockedCid,
  getBlockedCidMode,
  loadBlockedCids,
};
