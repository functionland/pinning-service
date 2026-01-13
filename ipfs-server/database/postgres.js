/**
 * PostgreSQL Database Module for IPFS Server
 *
 * This module provides PostgreSQL connectivity for the IPFS server (read-only operations).
 * The ipfs-server only needs to validate sessions and get user pool IDs.
 */

const pg = require('pg');
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

// Session validation (read-only)
async function validateSession(sessionToken) {
  const result = await query(
    'SELECT username FROM sessions WHERE session_token = $1',
    [sessionToken]
  );
  return result.rows[0];
}

// Get user pool ID (read-only)
async function getUserPoolId(username) {
  const result = await query(
    'SELECT pool_id FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0];
}

module.exports = {
  createPostgresPool,
  getPool,
  query,
  closePool,
  isPostgresConfigured,
  validateSession,
  getUserPoolId,
};
