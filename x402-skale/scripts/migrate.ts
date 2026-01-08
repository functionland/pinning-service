/**
 * Database Migration Script
 *
 * Initializes or updates the database schema.
 */

import Database from 'better-sqlite3';
import { schema } from '../src/database/schema.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const databasePath = process.env.DATABASE_PATH || './data/x402.db';

console.log('x402-skale Database Migration');
console.log('==============================');
console.log(`Database path: ${databasePath}`);

// Ensure data directory exists
const dataDir = path.dirname(databasePath);
if (!fs.existsSync(dataDir)) {
  console.log(`Creating data directory: ${dataDir}`);
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
console.log('Initializing database...');

const db = new Database(databasePath);

// Enable WAL mode
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Execute schema
console.log('Applying schema...');
db.exec(schema);

// Verify tables
const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name LIKE 'x402_%'
  ORDER BY name
`).all() as { name: string }[];

console.log('\nTables created:');
for (const table of tables) {
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get() as { count: number };
  console.log(`  - ${table.name} (${count.count} rows)`);
}

db.close();

console.log('\nMigration complete!');
