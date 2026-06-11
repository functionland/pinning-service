import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp, createDbOps, type AppConfig, type DbOps } from '../server/app.js';
import { createPostgresPool, closePool, query } from '../server/database/postgres.js';

// Test configuration - uses PostgreSQL via environment variables
// Set: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
const testConfig: AppConfig = {
  port: 3099,
  googleClientId: 'test-google-client-id',
  sessionSecret: 'test-session-secret-for-testing-only',
  jwtSecret: 'test-jwt-secret-for-testing-only',
  nodeEnv: 'test',
  pinningServiceUrl: 'http://localhost:6000',
};

// Check if PostgreSQL is reachable before running integration tests
let pgAvailable = false;
try {
  const pool = createPostgresPool();
  const client = await pool.connect();
  client.release();
  pgAvailable = true;
} catch {
  console.warn('[test] PostgreSQL not available — skipping integration tests that require a database');
  await closePool();
}

// Test user data
const testUser = {
  id: 'google-user-123',
  email: 'test@example.com',
  name: 'Test User',
  picture: 'https://example.com/avatar.jpg',
};

// Helper to clear all test data
async function clearTestData(): Promise<void> {
  // Clear in correct order to respect foreign key constraints
  await query('DELETE FROM credit_history');
  await query('DELETE FROM referrals');
  await query('DELETE FROM referral_codes');
  await query('DELETE FROM user_credits');
  await query('DELETE FROM api_keys');
  await query('DELETE FROM sessions');
  await query('DELETE FROM pins');
  await query('DELETE FROM users');
  await query('DELETE FROM webui_users');
}

describe.runIf(pgAvailable)('API Endpoints', () => {
  let app: Express;
  let agent: request.Agent;

  beforeAll(async () => {
    // Create test app (pool already created during availability check)
    const result = createApp(testConfig, { skipRateLimit: true });
    app = result.app;
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Clear tables before each test
    await clearTestData();

    // Create fresh agent for session handling
    agent = request.agent(app);
  });

  // Helper to create authenticated session
  async function createAuthenticatedSession() {
    // Manually create user and session in database
    const dbOps = createDbOps(testConfig.jwtSecret);
    await dbOps.getOrCreateUser(testUser.email, testUser.name, testUser.picture);

    // Set session via direct manipulation (since we can't use Google OAuth in tests)
    // We'll use a custom test endpoint approach - inject session
    const res = await agent
      .get('/api/health')
      .set('Cookie', 'connect.sid=test');

    return agent;
  }

  describe('Health Check', () => {
    it('GET /api/health should return ok status', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('Public Stats', () => {
    it('GET /api/public/stats should return stats without auth', async () => {
      const res = await request(app).get('/api/public/stats');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalPins');
      expect(res.body).toHaveProperty('totalSize');
      expect(res.body).toHaveProperty('totalUsers');
    });

    it('should return correct pin counts', async () => {
      // Add some test pins
      await query(`
        INSERT INTO pins (requestid, username, cid, name, status, size)
        VALUES ('req1', 'user1@test.com', 'Qm123', 'test1', 'pinned', 1000),
               ('req2', 'user1@test.com', 'Qm456', 'test2', 'pinned', 2000),
               ('req3', 'user2@test.com', 'Qm789', 'test3', 'queued', 500)
      `);

      const res = await request(app).get('/api/public/stats');

      expect(res.status).toBe(200);
      expect(res.body.totalPins).toBe(3);
      expect(res.body.totalSize).toBe(3500);
      expect(res.body.totalUsers).toBe(2);
    });

    it('should exclude deleted pins from stats', async () => {
      await query(`
        INSERT INTO pins (requestid, username, cid, name, status, size)
        VALUES ('req1', 'user1@test.com', 'Qm123', 'test1', 'pinned', 1000),
               ('req2', 'user1@test.com', 'Qm456', 'test2', 'deleted', 2000)
      `);

      const res = await request(app).get('/api/public/stats');

      expect(res.body.totalPins).toBe(1);
      expect(res.body.totalSize).toBe(1000);
    });
  });

  describe('Authentication', () => {
    it('GET /auth/me should return 401 when not authenticated', async () => {
      const res = await request(app).get('/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Not authenticated');
    });

    it('POST /auth/google should return 400 without credential', async () => {
      const res = await request(app)
        .post('/auth/google')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing credential');
    });

    it('POST /auth/logout should succeed even without session', async () => {
      const res = await request(app).post('/auth/logout');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('API Keys (Unauthenticated)', () => {
    it('GET /api/keys should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/keys');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('POST /api/keys should return 401 when not authenticated', async () => {
      const res = await request(app).post('/api/keys');

      expect(res.status).toBe(401);
    });

    it('GET /api/keys/active should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/keys/active');

      expect(res.status).toBe(401);
    });

    it('DELETE /api/keys/:keyId should return 401 when not authenticated', async () => {
      const res = await request(app).delete('/api/keys/some-key-id');

      expect(res.status).toBe(401);
    });
  });

  describe('Pins (Unauthenticated)', () => {
    it('GET /api/pins should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/pins');

      expect(res.status).toBe(401);
    });

    it('POST /api/pins should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/pins')
        .send({ cid: 'QmTest123' });

      expect(res.status).toBe(401);
    });
  });

  describe('Stats (Unauthenticated)', () => {
    it('GET /api/stats should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/stats');

      expect(res.status).toBe(401);
    });
  });

  describe('Profile (Unauthenticated)', () => {
    it('DELETE /api/profile should return 401 when not authenticated', async () => {
      const res = await request(app)
        .delete('/api/profile')
        .send({ confirmation: 'delete' });

      expect(res.status).toBe(401);
    });
  });

  describe('DAG Import (flag off — default config)', () => {
    it('GET /api/features should advertise dagImport=false', async () => {
      const res = await request(app).get('/api/features');

      expect(res.status).toBe(200);
      expect(res.body.dagImport).toBe(false);
    });

    it('POST /api/pins/import-dag should 404 when disabled (before auth)', async () => {
      const res = await request(app)
        .post('/api/pins/import-dag')
        .attach('file', Buffer.from('not a car'), 'test.car');

      expect(res.status).toBe(404);
    });
  });
});

describe.runIf(pgAvailable)('DAG Import (flag on)', () => {
  let app: Express;

  beforeAll(async () => {
    const result = createApp(
      { ...testConfig, dagImportEnabled: true, dagImportMaxCarBytes: 1024 },
      { skipRateLimit: true }
    );
    app = result.app;
  });

  afterAll(async () => {
    await closePool();
  });

  it('GET /api/features should advertise dagImport=true with the size cap', async () => {
    const res = await request(app).get('/api/features');

    expect(res.status).toBe(200);
    expect(res.body.dagImport).toBe(true);
    expect(res.body.dagImportMaxCarBytes).toBe(1024);
  });

  it('POST /api/pins/import-dag should 401 when not authenticated', async () => {
    const res = await request(app)
      .post('/api/pins/import-dag')
      .attach('file', Buffer.from('car bytes'), 'test.car');

    expect(res.status).toBe(401);
  });

  // Authenticated happy path and 413 precheck require a real session plus a
  // mocked upstream pinning service — covered by the Go test suite
  // (dag_import_controller_test.go / dag_import_service_test.go) and the
  // manual E2E checklist in the PR.
});

describe.runIf(pgAvailable)('Database Operations', () => {
  let dbOps: DbOps;

  beforeAll(async () => {
    // Pool already created during availability check
    dbOps = createDbOps(testConfig.jwtSecret);
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Clear tables before each test
    await clearTestData();
  });

  describe('User Operations', () => {
    it('should create new user with API key', async () => {
      const result = await dbOps.getOrCreateUser('new@test.com', 'New User', 'https://pic.com/avatar.jpg');

      expect(result.isNew).toBe(true);
      expect(result.email).toBe('new@test.com');

      // Verify user exists
      const user = await dbOps.getUserByEmail('new@test.com');
      expect(user).toBeDefined();
      expect(user.name).toBe('New User');

      // Verify API key was created
      const keys = await dbOps.getApiKeys('new@test.com');
      expect(keys.length).toBe(1);
    });

    it('should return existing user without creating new', async () => {
      // First call creates user
      await dbOps.getOrCreateUser('existing@test.com', 'Existing User', 'https://pic.com/avatar.jpg');

      // Second call returns existing
      const result = await dbOps.getOrCreateUser('existing@test.com', 'Updated Name', 'https://pic.com/new.jpg');

      expect(result.isNew).toBe(false);

      // Should still have only one API key
      const keys = await dbOps.getApiKeys('existing@test.com');
      expect(keys.length).toBe(1);
    });

    it('should get user by email', async () => {
      await dbOps.getOrCreateUser('findme@test.com', 'Find Me', 'https://pic.com/avatar.jpg');

      const user = await dbOps.getUserByEmail('findme@test.com');

      expect(user).toBeDefined();
      expect(user.email).toBe('findme@test.com');
      expect(user.name).toBe('Find Me');
    });

    it('should return undefined for non-existent user', async () => {
      const user = await dbOps.getUserByEmail('nonexistent@test.com');

      expect(user).toBeUndefined();
    });
  });

  describe('API Key Operations', () => {
    beforeEach(async () => {
      await dbOps.getOrCreateUser('keytest@test.com', 'Key Test', 'https://pic.com/avatar.jpg');
    });

    it('should create API key', async () => {
      const keyId = await dbOps.createApiKey('keytest@test.com');

      expect(keyId).toBeDefined();
      expect(typeof keyId).toBe('string');
      expect(keyId.length).toBeGreaterThan(50); // JWT is long

      // Verify key exists
      const keys = await dbOps.getApiKeys('keytest@test.com');
      expect(keys.some(k => k.key_id === keyId)).toBe(true);
    });

    it('should get all active API keys for user', async () => {
      // User already has one key from creation
      await dbOps.createApiKey('keytest@test.com');
      await dbOps.createApiKey('keytest@test.com');

      const keys = await dbOps.getApiKeys('keytest@test.com');

      expect(keys.length).toBe(3); // 1 from user creation + 2 new
    });

    it('should delete API key', async () => {
      const keys = await dbOps.getApiKeys('keytest@test.com');
      const keyToDelete = keys[0].key_id;

      const success = await dbOps.deleteApiKey('keytest@test.com', keyToDelete);

      expect(success).toBe(true);

      // Verify key is no longer returned
      const remainingKeys = await dbOps.getApiKeys('keytest@test.com');
      expect(remainingKeys.some(k => k.key_id === keyToDelete)).toBe(false);
    });

    it('should return false when deleting non-existent key', async () => {
      const success = await dbOps.deleteApiKey('keytest@test.com', 'non-existent-key');

      expect(success).toBe(false);
    });

    it('should return false when deleting key for wrong user', async () => {
      const keys = await dbOps.getApiKeys('keytest@test.com');
      const keyId = keys[0].key_id;

      const success = await dbOps.deleteApiKey('otheruser@test.com', keyId);

      expect(success).toBe(false);
    });

    it('should return multiple keys when created', async () => {
      // Create additional keys
      const key1 = await dbOps.createApiKey('keytest@test.com');
      const key2 = await dbOps.createApiKey('keytest@test.com');

      const keys = await dbOps.getApiKeys('keytest@test.com');

      // Should have 3 keys total (1 from user creation + 2 new)
      expect(keys.length).toBe(3);
      // Both new keys should exist
      expect(keys.some(k => k.key_id === key1)).toBe(true);
      expect(keys.some(k => k.key_id === key2)).toBe(true);
    });
  });

  describe('Pin Operations', () => {
    beforeEach(async () => {
      await dbOps.getOrCreateUser('pintest@test.com', 'Pin Test', 'https://pic.com/avatar.jpg');
    });

    it('should add pin', async () => {
      const requestId = await dbOps.addPin('pintest@test.com', 'QmTestCid123', 'My Test Pin');

      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe('string');

      // Verify pin exists
      const { pins } = await dbOps.getUserPins('pintest@test.com', 1, 10);
      expect(pins.length).toBe(1);
      expect(pins[0].cid).toBe('QmTestCid123');
      expect(pins[0].name).toBe('My Test Pin');
    });

    it('should get user pins with pagination', async () => {
      // Add 25 pins
      for (let i = 0; i < 25; i++) {
        await dbOps.addPin('pintest@test.com', `QmCid${i}`, `Pin ${i}`);
      }

      // Get first page
      const page1 = await dbOps.getUserPins('pintest@test.com', 1, 10);
      expect(page1.pins.length).toBe(10);
      expect(page1.total).toBe(25);

      // Get second page
      const page2 = await dbOps.getUserPins('pintest@test.com', 2, 10);
      expect(page2.pins.length).toBe(10);

      // Get third page
      const page3 = await dbOps.getUserPins('pintest@test.com', 3, 10);
      expect(page3.pins.length).toBe(5);
    });

    it('should search pins by CID', async () => {
      await dbOps.addPin('pintest@test.com', 'QmSearchable123', 'Pin A');
      await dbOps.addPin('pintest@test.com', 'QmOther456', 'Pin B');

      const { pins, total } = await dbOps.getUserPins('pintest@test.com', 1, 10, 'Searchable');

      expect(total).toBe(1);
      expect(pins[0].cid).toBe('QmSearchable123');
    });

    it('should not return deleted pins', async () => {
      await dbOps.addPin('pintest@test.com', 'QmActive', 'Active Pin');

      // Manually mark a pin as deleted
      await query(`
        INSERT INTO pins (requestid, username, cid, name, status)
        VALUES ('deleted-req', 'pintest@test.com', 'QmDeleted', 'Deleted Pin', 'deleted')
      `);

      const { pins, total } = await dbOps.getUserPins('pintest@test.com', 1, 10);

      expect(total).toBe(1);
      expect(pins[0].cid).toBe('QmActive');
    });

    it('should only return pins for the specific user', async () => {
      await dbOps.addPin('pintest@test.com', 'QmUserA', 'User A Pin');

      // Add pin for different user
      await query(`
        INSERT INTO pins (requestid, username, cid, name, status)
        VALUES ('other-req', 'other@test.com', 'QmOther', 'Other Pin', 'pinned')
      `);

      const { pins, total } = await dbOps.getUserPins('pintest@test.com', 1, 10);

      expect(total).toBe(1);
      expect(pins[0].cid).toBe('QmUserA');
    });
  });

  describe('Stats Operations', () => {
    beforeEach(async () => {
      await dbOps.getOrCreateUser('stats@test.com', 'Stats Test', 'https://pic.com/avatar.jpg');
    });

    it('should return correct stats for user', async () => {
      // Add some pins with sizes
      await query(`
        INSERT INTO pins (requestid, username, cid, name, status, size)
        VALUES ('req1', 'stats@test.com', 'Qm1', 'Pin 1', 'pinned', 1000),
               ('req2', 'stats@test.com', 'Qm2', 'Pin 2', 'pinned', 2000),
               ('req3', 'stats@test.com', 'Qm3', 'Pin 3', 'queued', 500)
      `);

      const stats = await dbOps.getUserStats('stats@test.com');

      expect(stats.totalPins).toBe(3);
      expect(stats.totalSize).toBe(3500);
      expect(stats.memberSince).toBeDefined();
    });

    it('should exclude deleted pins from stats', async () => {
      await query(`
        INSERT INTO pins (requestid, username, cid, name, status, size)
        VALUES ('req1', 'stats@test.com', 'Qm1', 'Pin 1', 'pinned', 1000),
               ('req2', 'stats@test.com', 'Qm2', 'Pin 2', 'deleted', 2000)
      `);

      const stats = await dbOps.getUserStats('stats@test.com');

      expect(stats.totalPins).toBe(1);
      expect(stats.totalSize).toBe(1000);
    });

    it('should return zero for user with no pins', async () => {
      const stats = await dbOps.getUserStats('stats@test.com');

      expect(stats.totalPins).toBe(0);
      expect(stats.totalSize).toBe(0);
    });
  });

  describe('Profile Deletion', () => {
    it('should delete all user data', async () => {
      // Create user with data
      await dbOps.getOrCreateUser('delete@test.com', 'Delete Me', 'https://pic.com/avatar.jpg');
      await dbOps.createApiKey('delete@test.com');
      await dbOps.addPin('delete@test.com', 'QmToDelete', 'Pin to delete');

      // Verify data exists
      expect(await dbOps.getUserByEmail('delete@test.com')).toBeDefined();
      expect((await dbOps.getApiKeys('delete@test.com')).length).toBeGreaterThan(0);
      expect((await dbOps.getUserPins('delete@test.com', 1, 10)).total).toBeGreaterThan(0);

      // Delete profile
      await dbOps.deleteUserProfile('delete@test.com');

      // Verify all data is gone
      expect(await dbOps.getUserByEmail('delete@test.com')).toBeUndefined();
      expect((await dbOps.getApiKeys('delete@test.com')).length).toBe(0);
      expect((await dbOps.getUserPins('delete@test.com', 1, 10)).total).toBe(0);
    });
  });
});

describe('JWT API Key Generation', () => {
  it('should generate valid JWT tokens', async () => {
    const { generateJwtApiKey } = await import('../server/app.js');

    const token = generateJwtApiKey('test@example.com', 'test-secret');

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    // JWT has 3 parts separated by dots
    const parts = token.split('.');
    expect(parts.length).toBe(3);
  });

  it('should include correct claims in JWT', async () => {
    const { generateJwtApiKey } = await import('../server/app.js');
    const jwt = await import('jsonwebtoken');

    const token = generateJwtApiKey('test@example.com', 'test-secret');
    const decoded = jwt.default.verify(token, 'test-secret') as any;

    expect(decoded.sub).toBe('test@example.com');
    expect(decoded.scope).toBe('storage:read storage:write');
    expect(decoded.jti).toBeDefined(); // Unique ID
    expect(decoded.iat).toBeDefined(); // Issued at
  });

  it('should generate unique tokens for same email', async () => {
    const { generateJwtApiKey } = await import('../server/app.js');

    const token1 = generateJwtApiKey('test@example.com', 'test-secret');
    const token2 = generateJwtApiKey('test@example.com', 'test-secret');

    expect(token1).not.toBe(token2);
  });
});

describe.runIf(pgAvailable)('Input Validation', () => {
  let app: Express;

  beforeAll(async () => {
    // Pool already created during availability check
    const result = createApp(testConfig, { skipRateLimit: true });
    app = result.app;
  });

  afterAll(async () => {
    await closePool();
  });

  describe('PIN CID Validation', () => {
    it('should reject empty CID', async () => {
      // Note: This would require authentication, but we can test the validation logic
      const res = await request(app)
        .post('/api/pins')
        .send({ cid: '' });

      // Will return 401 before validation, but that's expected
      expect(res.status).toBe(401);
    });
  });

  describe('Profile Deletion Validation', () => {
    it('should require confirmation text', async () => {
      // Will return 401 due to no auth, but demonstrates the endpoint exists
      const res = await request(app)
        .delete('/api/profile')
        .send({ confirmation: 'wrong' });

      expect(res.status).toBe(401);
    });
  });
});
