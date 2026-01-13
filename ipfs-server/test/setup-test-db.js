/**
 * Setup test database for ipfs-server tests
 * Creates test user and session in PostgreSQL
 *
 * Requires PostgreSQL environment variables:
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
 *
 * For testing, use a Docker container:
 *   docker run -d --name postgres-test \
 *     -e POSTGRES_DB=pinning_service_test \
 *     -e POSTGRES_USER=test_user \
 *     -e POSTGRES_PASSWORD=test_pass \
 *     -p 5433:5432 \
 *     postgres:15
 */

const { createPostgresPool, query, closePool } = require('../database/postgres.js');

const TEST_TOKEN = 'test-token-for-ipfs-gateway';
const TEST_USERNAME = 'test@gateway.local';
const TEST_POOL_ID = 42;

async function setupTestDatabase() {
  console.log('Setting up PostgreSQL test database...');

  // Initialize connection pool
  createPostgresPool();

  // Clear any existing test data
  await query('DELETE FROM sessions WHERE username = $1', [TEST_USERNAME]);
  await query('DELETE FROM users WHERE username = $1', [TEST_USERNAME]);

  // Insert test user
  await query(
    `INSERT INTO users (username, password_hash, pool_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET pool_id = $3`,
    [TEST_USERNAME, 'test-hash', TEST_POOL_ID]
  );

  // Insert test session
  await query(
    `INSERT INTO sessions (username, session_token, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (session_token) DO UPDATE SET username = $1, created_at = NOW()`,
    [TEST_USERNAME, TEST_TOKEN]
  );

  console.log('Test database setup complete:');
  console.log('  Test token:', TEST_TOKEN);
  console.log('  Test username:', TEST_USERNAME);
  console.log('  Test pool_id:', TEST_POOL_ID);

  return {
    token: TEST_TOKEN,
    username: TEST_USERNAME,
    poolId: TEST_POOL_ID
  };
}

async function cleanupTestDatabase() {
  console.log('Cleaning up PostgreSQL test database...');

  // Remove test data
  await query('DELETE FROM sessions WHERE username = $1', [TEST_USERNAME]);
  await query('DELETE FROM users WHERE username = $1', [TEST_USERNAME]);

  // Close pool
  await closePool();

  console.log('Test database cleanup complete');
}

// Run if called directly
if (require.main === module) {
  setupTestDatabase()
    .then(() => {
      console.log('Setup complete');
      return closePool();
    })
    .catch(err => {
      console.error('Setup failed:', err);
      process.exit(1);
    });
}

module.exports = {
  setupTestDatabase,
  cleanupTestDatabase,
  TEST_TOKEN,
  TEST_USERNAME,
  TEST_POOL_ID
};
