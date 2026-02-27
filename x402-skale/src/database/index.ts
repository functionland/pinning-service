/**
 * Database Connection Manager
 *
 * PostgreSQL database connection using connection pool.
 */

import {
  createPostgresPool,
  getPool,
  query,
  closePool,
  isPostgresConfigured,
  verifyConnection,
} from './postgres.js';

/**
 * Initialize the database connection pool
 */
export async function initializeDatabase(): Promise<void> {
  console.log('[database] Initializing PostgreSQL connection pool...');
  createPostgresPool();

  // Verify connection
  const connected = await verifyConnection();
  if (!connected) {
    throw new Error('Failed to connect to PostgreSQL database');
  }

  // Verify required tables exist
  const tables = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const tableNames = tables.rows.map(r => r.tablename);
  const required = ['x402_ephemeral_objects', 'x402_payment_logs'];
  for (const t of required) {
    if (!tableNames.includes(t)) {
      console.error(`[database] FATAL: Required table '${t}' missing. Run migrations first.`);
      process.exit(1);
    }
  }

  console.log('[database] PostgreSQL connected successfully');
}

/**
 * Close the database connection pool
 */
export async function closeDatabase(): Promise<void> {
  await closePool();
  console.log('[database] Connection pool closed');
}

// Re-export for use in repositories
export { query, getPool, isPostgresConfigured };
