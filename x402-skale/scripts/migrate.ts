/**
 * Database Migration Script (PostgreSQL)
 *
 * Initializes or updates the database schema.
 */

import pg from 'pg';
import { schema } from '../src/database/schema.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment
dotenv.config({ path: path.resolve(__dirname, '../.env') });

console.log('x402-skale Database Migration (PostgreSQL)');
console.log('==========================================');

// Get PostgreSQL configuration
const config = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'pinning_service',
  user: process.env.POSTGRES_USER || 'pinning_user',
  password: process.env.POSTGRES_PASSWORD || '',
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

console.log(`Host: ${config.host}:${config.port}`);
console.log(`Database: ${config.database}`);
console.log(`User: ${config.user}`);

// Create pool
const pool = new Pool(config);

async function runMigration() {
  try {
    // Test connection
    console.log('\nConnecting to PostgreSQL...');
    const client = await pool.connect();
    console.log('Connected successfully!');

    // Execute schema
    console.log('\nApplying schema...');

    // Split schema into individual statements and execute each
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      try {
        await client.query(statement);
      } catch (err: any) {
        // Ignore "already exists" errors for idempotency
        if (!err.message.includes('already exists')) {
          console.error(`Error executing: ${statement.substring(0, 50)}...`);
          throw err;
        }
      }
    }

    // Verify tables
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'x402_%'
      ORDER BY table_name
    `);

    console.log('\nTables created:');
    for (const row of tablesResult.rows) {
      const countResult = await client.query(`SELECT COUNT(*) as count FROM ${row.table_name}`);
      console.log(`  - ${row.table_name} (${countResult.rows[0].count} rows)`);
    }

    client.release();
    await pool.end();

    console.log('\nMigration complete!');
  } catch (error) {
    console.error('\nMigration failed:', error);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
