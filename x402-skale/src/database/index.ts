/**
 * Database Connection Manager
 *
 * Initializes SQLite database with schema and provides connection.
 */

import Database from 'better-sqlite3';
import { schema } from './schema.js';
import { config } from '../config/index.js';

let db: Database.Database | null = null;

/**
 * Initialize the database connection and create schema
 */
export function initializeDatabase(): Database.Database {
  if (db) {
    return db;
  }

  console.log(`[database] Initializing SQLite at ${config.databasePath}`);

  db = new Database(config.databasePath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Create schema
  db.exec(schema);

  console.log('[database] Schema initialized successfully');

  return db;
}

/**
 * Get the database connection (must call initializeDatabase first)
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[database] Connection closed');
  }
}

export { Database };
