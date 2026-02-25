/**
 * Database Connection Manager
 *
 * PostgreSQL database connection and migration runner.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createPostgresPool,
  query,
  closePool,
  verifyConnection,
} from './postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Initialize the database connection pool and run migrations
 */
export async function initializeDatabase(): Promise<void> {
  console.log('[database] Initializing PostgreSQL connection pool...');
  createPostgresPool();

  // Verify connection
  const connected = await verifyConnection();
  if (!connected) {
    throw new Error('Failed to connect to PostgreSQL database');
  }

  console.log('[database] PostgreSQL connected successfully');

  // Run migrations
  await runMigrations();
}

/**
 * Run SQL migrations (idempotent — uses CREATE TABLE IF NOT EXISTS).
 *
 * NOTE: All migration files run on every startup. This is safe ONLY because
 * every statement uses IF NOT EXISTS / IF EXISTS guards. If you add data
 * migrations or ALTER statements, add a migration-tracking table first.
 */
async function runMigrations(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../../migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.log('[database] No migrations directory found, skipping');
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await query(sql);
      console.log(`[database] Migration applied: ${file}`);
    } catch (error) {
      console.error(`[database] Migration failed: ${file}`, error);
      throw error;
    }
  }
}

/**
 * Close the database connection pool
 */
export async function closeDatabase(): Promise<void> {
  await closePool();
  console.log('[database] Connection pool closed');
}

// Re-export for use elsewhere
export { query } from './postgres.js';
