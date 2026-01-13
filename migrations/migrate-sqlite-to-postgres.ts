/**
 * SQLite to PostgreSQL Migration Script
 *
 * This script migrates admin and system data from SQLite databases to PostgreSQL.
 * It preserves all table names and column names.
 *
 * Usage:
 *   npx ts-node migrations/migrate-sqlite-to-postgres.ts
 *
 * Environment variables required:
 *   - POSTGRES_HOST
 *   - POSTGRES_PORT
 *   - POSTGRES_DB
 *   - POSTGRES_USER
 *   - POSTGRES_PASSWORD
 *   - SQLITE_PATH (optional, defaults to ./data/pinning.db)
 *   - X402_SQLITE_PATH (optional, defaults to ./data/x402.db)
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'path';
import fs from 'fs';

const { Pool } = pg;

// Configuration
interface MigrationConfig {
  sqlitePath: string;
  x402SqlitePath: string;
  postgresConfig: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
  };
}

// Table configuration
interface TableConfig {
  name: string;
  migrate: boolean;
  source: 'main' | 'x402';
  orderBy: string;
  dependsOn?: string[];
}

// Tables to migrate in order (respects foreign key dependencies)
const TABLES_TO_MIGRATE: TableConfig[] = [
  // Core tables (no dependencies)
  { name: 'users', migrate: true, source: 'main', orderBy: 'id' },
  { name: 'webui_users', migrate: true, source: 'main', orderBy: 'id' },

  // Tables depending on users
  { name: 'sessions', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['users'] },
  { name: 'logins', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['users'] },

  // Tables depending on webui_users
  { name: 'api_keys', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['webui_users'] },
  { name: 'user_wallets', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['webui_users'] },
  { name: 'user_credits', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['webui_users'] },
  { name: 'credit_history', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['webui_users'] },
  { name: 'referral_codes', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['webui_users'] },
  { name: 'referrals', migrate: true, source: 'main', orderBy: 'id', dependsOn: ['webui_users', 'referral_codes'] },

  // Standalone tables
  { name: 'token_transactions', migrate: true, source: 'main', orderBy: 'id' },

  // x402 tables
  { name: 'x402_payment_logs', migrate: true, source: 'x402', orderBy: 'id' },
  { name: 'x402_ephemeral_objects', migrate: true, source: 'x402', orderBy: 'id' },

  // Tables to skip (can be re-synced or recalculated)
  { name: 'pins', migrate: false, source: 'main', orderBy: 'id' },
  { name: 'chain_sync_state', migrate: false, source: 'main', orderBy: 'id' },
  { name: 'x402_gateway_stats', migrate: false, source: 'x402', orderBy: 'id' },
];

// Get column info from SQLite table
interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function getConfig(): MigrationConfig {
  const requiredEnvVars = ['POSTGRES_HOST', 'POSTGRES_USER', 'POSTGRES_PASSWORD'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    sqlitePath: process.env.SQLITE_PATH || './data/pinning.db',
    x402SqlitePath: process.env.X402_SQLITE_PATH || './data/x402.db',
    postgresConfig: {
      host: process.env.POSTGRES_HOST!,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'pinning_service',
      user: process.env.POSTGRES_USER!,
      password: process.env.POSTGRES_PASSWORD!,
      ssl: process.env.POSTGRES_SSL === 'true',
    },
  };
}

async function checkTableExists(pool: pg.Pool, tableName: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = $1
    )`,
    [tableName]
  );
  return result.rows[0].exists;
}

async function getPostgresRowCount(pool: pg.Pool, tableName: string): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
  return parseInt(result.rows[0].count, 10);
}

function getSqliteRowCount(db: Database.Database, tableName: string): number {
  const result = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number };
  return result.count;
}

function getTableColumns(db: Database.Database, tableName: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];
}

function formatValue(value: any, columnType: string): any {
  if (value === null || value === undefined) {
    return null;
  }

  // Handle DATETIME/TIMESTAMPTZ conversion
  if (columnType.includes('DATETIME') || columnType.includes('TIMESTAMP')) {
    // SQLite stores dates as strings, PostgreSQL needs proper timestamps
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
  }

  // Handle boolean conversion (SQLite uses 0/1)
  if (columnType.includes('BOOLEAN') || columnType.includes('BOOL')) {
    return value === 1 || value === '1' || value === true;
  }

  return value;
}

async function migrateTable(
  sqliteDb: Database.Database,
  pgPool: pg.Pool,
  tableConfig: TableConfig
): Promise<{ success: boolean; rowsMigrated: number; error?: string }> {
  const { name: tableName, orderBy } = tableConfig;

  console.log(`\n📋 Migrating table: ${tableName}`);

  try {
    // Check if table exists in PostgreSQL
    const exists = await checkTableExists(pgPool, tableName);
    if (!exists) {
      console.log(`  ⚠️  Table ${tableName} does not exist in PostgreSQL. Skipping.`);
      return { success: false, rowsMigrated: 0, error: 'Table does not exist in PostgreSQL' };
    }

    // Check if SQLite table exists and has data
    let sqliteRowCount: number;
    try {
      sqliteRowCount = getSqliteRowCount(sqliteDb, tableName);
    } catch (err) {
      console.log(`  ⚠️  Table ${tableName} does not exist in SQLite. Skipping.`);
      return { success: true, rowsMigrated: 0 };
    }

    if (sqliteRowCount === 0) {
      console.log(`  ℹ️  Table ${tableName} is empty in SQLite. Skipping.`);
      return { success: true, rowsMigrated: 0 };
    }

    // Check if PostgreSQL table already has data
    const pgRowCount = await getPostgresRowCount(pgPool, tableName);
    if (pgRowCount > 0) {
      console.log(`  ⚠️  Table ${tableName} already has ${pgRowCount} rows in PostgreSQL.`);
      console.log(`  ⚠️  Skipping to avoid duplicates. Clear the table first if you want to re-migrate.`);
      return { success: true, rowsMigrated: 0 };
    }

    console.log(`  📊 Found ${sqliteRowCount} rows to migrate`);

    // Get column information
    const columns = getTableColumns(sqliteDb, tableName);
    const columnNames = columns.map(c => c.name);

    // Read all data from SQLite
    const rows = sqliteDb.prepare(`SELECT * FROM ${tableName} ORDER BY ${orderBy}`).all();

    // Build INSERT statement
    const placeholders = columnNames.map((_, i) => `$${i + 1}`).join(', ');
    const insertSql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders})`;

    // Migrate in batches
    const batchSize = 100;
    let migratedCount = 0;

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // Disable foreign key checks temporarily for migration
      // (PostgreSQL doesn't have a global FK disable, but we ordered tables correctly)

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        for (const row of batch) {
          const values = columnNames.map((colName, idx) => {
            const colType = columns[idx].type;
            return formatValue((row as any)[colName], colType);
          });

          await client.query(insertSql, values);
          migratedCount++;
        }

        // Progress update
        const progress = Math.round((migratedCount / sqliteRowCount) * 100);
        process.stdout.write(`\r  ⏳ Progress: ${migratedCount}/${sqliteRowCount} (${progress}%)`);
      }

      await client.query('COMMIT');

      // Update sequence if table has serial/identity column
      if (columns.some(c => c.pk === 1)) {
        const pkColumn = columns.find(c => c.pk === 1)!;
        const maxIdResult = await pgPool.query(`SELECT MAX(${pkColumn.name}) as max_id FROM ${tableName}`);
        const maxId = maxIdResult.rows[0].max_id || 0;
        if (maxId > 0) {
          await pgPool.query(`SELECT setval(pg_get_serial_sequence('${tableName}', '${pkColumn.name}'), $1, true)`, [maxId]);
        }
      }

      console.log(`\n  ✅ Successfully migrated ${migratedCount} rows`);
      return { success: true, rowsMigrated: migratedCount };

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.log(`\n  ❌ Error migrating ${tableName}: ${errorMessage}`);
    return { success: false, rowsMigrated: 0, error: errorMessage };
  }
}

async function runMigration() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   SQLite to PostgreSQL Migration Script');
  console.log('═══════════════════════════════════════════════════════════════');

  // Load environment variables from .env if present
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      envContent.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0 && !process.env[key.trim()]) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      });
    }
  } catch (err) {
    // Ignore .env loading errors
  }

  const config = getConfig();

  console.log('\n📁 Configuration:');
  console.log(`   Main SQLite: ${config.sqlitePath}`);
  console.log(`   x402 SQLite: ${config.x402SqlitePath}`);
  console.log(`   PostgreSQL:  ${config.postgresConfig.host}:${config.postgresConfig.port}/${config.postgresConfig.database}`);

  // Verify SQLite databases exist
  if (!fs.existsSync(config.sqlitePath)) {
    console.error(`\n❌ Main SQLite database not found: ${config.sqlitePath}`);
    process.exit(1);
  }

  // Open SQLite databases
  console.log('\n🔌 Connecting to databases...');

  const mainDb = new Database(config.sqlitePath, { readonly: true });
  let x402Db: Database.Database | null = null;

  if (fs.existsSync(config.x402SqlitePath)) {
    x402Db = new Database(config.x402SqlitePath, { readonly: true });
    console.log('   ✅ Connected to main SQLite database');
    console.log('   ✅ Connected to x402 SQLite database');
  } else {
    console.log('   ✅ Connected to main SQLite database');
    console.log('   ⚠️  x402 SQLite database not found, x402 tables will be skipped');
  }

  // Connect to PostgreSQL
  const pgPool = new Pool({
    ...config.postgresConfig,
    ssl: config.postgresConfig.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
  });

  try {
    await pgPool.query('SELECT 1');
    console.log('   ✅ Connected to PostgreSQL database');
  } catch (err) {
    console.error(`\n❌ Failed to connect to PostgreSQL: ${err}`);
    process.exit(1);
  }

  // Migration results
  const results: { table: string; success: boolean; rowsMigrated: number; error?: string }[] = [];

  console.log('\n' + '─'.repeat(65));
  console.log(' Starting Migration');
  console.log('─'.repeat(65));

  // Migrate tables in order
  for (const tableConfig of TABLES_TO_MIGRATE) {
    if (!tableConfig.migrate) {
      console.log(`\n⏭️  Skipping table: ${tableConfig.name} (configured to skip)`);
      continue;
    }

    const db = tableConfig.source === 'x402' ? x402Db : mainDb;
    if (!db) {
      console.log(`\n⏭️  Skipping table: ${tableConfig.name} (database not available)`);
      continue;
    }

    const result = await migrateTable(db, pgPool, tableConfig);
    results.push({ table: tableConfig.name, ...result });
  }

  // Summary
  console.log('\n' + '═'.repeat(65));
  console.log(' Migration Summary');
  console.log('═'.repeat(65));

  let totalMigrated = 0;
  let successCount = 0;
  let failCount = 0;

  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    const rows = result.rowsMigrated > 0 ? `${result.rowsMigrated} rows` : 'no data';
    console.log(`   ${status} ${result.table}: ${rows}${result.error ? ` (${result.error})` : ''}`);

    totalMigrated += result.rowsMigrated;
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  console.log('\n' + '─'.repeat(65));
  console.log(`   Total rows migrated: ${totalMigrated}`);
  console.log(`   Tables succeeded: ${successCount}`);
  console.log(`   Tables failed: ${failCount}`);
  console.log('═'.repeat(65));

  // Cleanup
  mainDb.close();
  if (x402Db) {
    x402Db.close();
  }
  await pgPool.end();

  if (failCount > 0) {
    console.log('\n⚠️  Some tables failed to migrate. Please check the errors above.');
    process.exit(1);
  } else {
    console.log('\n✅ Migration completed successfully!');
  }
}

// Run migration
runMigration().catch(err => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
