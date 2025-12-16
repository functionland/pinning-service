/**
 * Setup test database for ipfs-server tests
 * Creates a SQLite database with test user and session
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test.db');
const TEST_TOKEN = 'test-token-for-ipfs-gateway';
const TEST_USERNAME = 'test@gateway.local';

function setupTestDatabase() {
  // Remove existing test database
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }

  const db = new Database(TEST_DB_PATH);

  // Create tables (matching pinning service schema)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      pool_id INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      session_token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  `);

  // Insert test user
  db.prepare(`
    INSERT OR REPLACE INTO users (username, password_hash, pool_id)
    VALUES (?, ?, ?)
  `).run(TEST_USERNAME, 'test-hash', 42);

  // Insert test session
  db.prepare(`
    INSERT OR REPLACE INTO sessions (username, session_token)
    VALUES (?, ?)
  `).run(TEST_USERNAME, TEST_TOKEN);

  db.close();

  console.log('Test database created:', TEST_DB_PATH);
  console.log('Test token:', TEST_TOKEN);
  console.log('Test username:', TEST_USERNAME);
  console.log('Test pool_id:', 42);

  return {
    dbPath: TEST_DB_PATH,
    token: TEST_TOKEN,
    username: TEST_USERNAME,
    poolId: 42
  };
}

// Run if called directly
if (require.main === module) {
  setupTestDatabase();
}

module.exports = { setupTestDatabase, TEST_DB_PATH, TEST_TOKEN, TEST_USERNAME };
