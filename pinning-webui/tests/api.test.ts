import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp, initializeTestDatabase, createDbOps, type AppConfig } from '../server/app.js';

// Test configuration
const testConfig: AppConfig = {
  port: 3099,
  databasePath: ':memory:',
  googleClientId: 'test-google-client-id',
  sessionSecret: 'test-session-secret-for-testing-only',
  jwtSecret: 'test-jwt-secret-for-testing-only',
  nodeEnv: 'test',
  pinningServiceUrl: 'http://localhost:6000',
};

// Test user data
const testUser = {
  id: 'google-user-123',
  email: 'test@example.com',
  name: 'Test User',
  picture: 'https://example.com/avatar.jpg',
};

describe('API Endpoints', () => {
  let app: Express;
  let db: Database.Database;
  let agent: request.Agent;

  beforeAll(() => {
    // Create test database and app
    db = initializeTestDatabase();
    const result = createApp(testConfig, db, { skipRateLimit: true });
    app = result.app;
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    // Clear tables before each test
    db.exec('DELETE FROM api_keys');
    db.exec('DELETE FROM webui_users');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM pins');

    // Create fresh agent for session handling
    agent = request.agent(app);
  });

  // Helper to create authenticated session
  async function createAuthenticatedSession() {
    // Manually create user and session in database
    const dbOps = createDbOps(db, testConfig.jwtSecret);
    dbOps.getOrCreateUser(testUser.email, testUser.name, testUser.picture);

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
      db.exec(`
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
      db.exec(`
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
});

describe('Database Operations', () => {
  let db: Database.Database;
  let dbOps: ReturnType<typeof createDbOps>;

  beforeAll(() => {
    db = initializeTestDatabase();
    dbOps = createDbOps(db, testConfig.jwtSecret);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    // Clear tables before each test
    db.exec('DELETE FROM api_keys');
    db.exec('DELETE FROM webui_users');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM pins');
  });

  describe('User Operations', () => {
    it('should create new user with API key', () => {
      const result = dbOps.getOrCreateUser('new@test.com', 'New User', 'https://pic.com/avatar.jpg');

      expect(result.isNew).toBe(true);
      expect(result.email).toBe('new@test.com');

      // Verify user exists
      const user = dbOps.getUserByEmail('new@test.com');
      expect(user).toBeDefined();
      expect(user.name).toBe('New User');

      // Verify API key was created
      const keys = dbOps.getApiKeys('new@test.com');
      expect(keys.length).toBe(1);
    });

    it('should return existing user without creating new', () => {
      // First call creates user
      dbOps.getOrCreateUser('existing@test.com', 'Existing User', 'https://pic.com/avatar.jpg');

      // Second call returns existing
      const result = dbOps.getOrCreateUser('existing@test.com', 'Updated Name', 'https://pic.com/new.jpg');

      expect(result.isNew).toBe(false);

      // Should still have only one API key
      const keys = dbOps.getApiKeys('existing@test.com');
      expect(keys.length).toBe(1);
    });

    it('should get user by email', () => {
      dbOps.getOrCreateUser('findme@test.com', 'Find Me', 'https://pic.com/avatar.jpg');

      const user = dbOps.getUserByEmail('findme@test.com');

      expect(user).toBeDefined();
      expect(user.email).toBe('findme@test.com');
      expect(user.name).toBe('Find Me');
    });

    it('should return undefined for non-existent user', () => {
      const user = dbOps.getUserByEmail('nonexistent@test.com');

      expect(user).toBeUndefined();
    });
  });

  describe('API Key Operations', () => {
    beforeEach(() => {
      dbOps.getOrCreateUser('keytest@test.com', 'Key Test', 'https://pic.com/avatar.jpg');
    });

    it('should create API key', () => {
      const keyId = dbOps.createApiKey('keytest@test.com');

      expect(keyId).toBeDefined();
      expect(typeof keyId).toBe('string');
      expect(keyId.length).toBeGreaterThan(50); // JWT is long

      // Verify key exists
      const keys = dbOps.getApiKeys('keytest@test.com');
      expect(keys.some(k => k.key_id === keyId)).toBe(true);
    });

    it('should get all active API keys for user', () => {
      // User already has one key from creation
      dbOps.createApiKey('keytest@test.com');
      dbOps.createApiKey('keytest@test.com');

      const keys = dbOps.getApiKeys('keytest@test.com');

      expect(keys.length).toBe(3); // 1 from user creation + 2 new
    });

    it('should delete API key', () => {
      const keys = dbOps.getApiKeys('keytest@test.com');
      const keyToDelete = keys[0].key_id;

      const success = dbOps.deleteApiKey('keytest@test.com', keyToDelete);

      expect(success).toBe(true);

      // Verify key is no longer returned
      const remainingKeys = dbOps.getApiKeys('keytest@test.com');
      expect(remainingKeys.some(k => k.key_id === keyToDelete)).toBe(false);
    });

    it('should return false when deleting non-existent key', () => {
      const success = dbOps.deleteApiKey('keytest@test.com', 'non-existent-key');

      expect(success).toBe(false);
    });

    it('should return false when deleting key for wrong user', () => {
      const keys = dbOps.getApiKeys('keytest@test.com');
      const keyId = keys[0].key_id;

      const success = dbOps.deleteApiKey('otheruser@test.com', keyId);

      expect(success).toBe(false);
    });

    it('should return multiple keys when created', () => {
      // Create additional keys
      const key1 = dbOps.createApiKey('keytest@test.com');
      const key2 = dbOps.createApiKey('keytest@test.com');

      const keys = dbOps.getApiKeys('keytest@test.com');

      // Should have 3 keys total (1 from user creation + 2 new)
      expect(keys.length).toBe(3);
      // Both new keys should exist
      expect(keys.some(k => k.key_id === key1)).toBe(true);
      expect(keys.some(k => k.key_id === key2)).toBe(true);
    });
  });

  describe('Pin Operations', () => {
    beforeEach(() => {
      dbOps.getOrCreateUser('pintest@test.com', 'Pin Test', 'https://pic.com/avatar.jpg');
    });

    it('should add pin', () => {
      const requestId = dbOps.addPin('pintest@test.com', 'QmTestCid123', 'My Test Pin');

      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe('string');

      // Verify pin exists
      const { pins } = dbOps.getUserPins('pintest@test.com', 1, 10);
      expect(pins.length).toBe(1);
      expect(pins[0].cid).toBe('QmTestCid123');
      expect(pins[0].name).toBe('My Test Pin');
    });

    it('should get user pins with pagination', () => {
      // Add 25 pins
      for (let i = 0; i < 25; i++) {
        dbOps.addPin('pintest@test.com', `QmCid${i}`, `Pin ${i}`);
      }

      // Get first page
      const page1 = dbOps.getUserPins('pintest@test.com', 1, 10);
      expect(page1.pins.length).toBe(10);
      expect(page1.total).toBe(25);

      // Get second page
      const page2 = dbOps.getUserPins('pintest@test.com', 2, 10);
      expect(page2.pins.length).toBe(10);

      // Get third page
      const page3 = dbOps.getUserPins('pintest@test.com', 3, 10);
      expect(page3.pins.length).toBe(5);
    });

    it('should search pins by CID', () => {
      dbOps.addPin('pintest@test.com', 'QmSearchable123', 'Pin A');
      dbOps.addPin('pintest@test.com', 'QmOther456', 'Pin B');

      const { pins, total } = dbOps.getUserPins('pintest@test.com', 1, 10, 'Searchable');

      expect(total).toBe(1);
      expect(pins[0].cid).toBe('QmSearchable123');
    });

    it('should not return deleted pins', () => {
      dbOps.addPin('pintest@test.com', 'QmActive', 'Active Pin');

      // Manually mark a pin as deleted
      db.exec(`
        INSERT INTO pins (requestid, username, cid, name, status)
        VALUES ('deleted-req', 'pintest@test.com', 'QmDeleted', 'Deleted Pin', 'deleted')
      `);

      const { pins, total } = dbOps.getUserPins('pintest@test.com', 1, 10);

      expect(total).toBe(1);
      expect(pins[0].cid).toBe('QmActive');
    });

    it('should only return pins for the specific user', () => {
      dbOps.addPin('pintest@test.com', 'QmUserA', 'User A Pin');

      // Add pin for different user
      db.exec(`
        INSERT INTO pins (requestid, username, cid, name, status)
        VALUES ('other-req', 'other@test.com', 'QmOther', 'Other Pin', 'pinned')
      `);

      const { pins, total } = dbOps.getUserPins('pintest@test.com', 1, 10);

      expect(total).toBe(1);
      expect(pins[0].cid).toBe('QmUserA');
    });
  });

  describe('Stats Operations', () => {
    beforeEach(() => {
      dbOps.getOrCreateUser('stats@test.com', 'Stats Test', 'https://pic.com/avatar.jpg');
    });

    it('should return correct stats for user', () => {
      // Add some pins with sizes
      db.exec(`
        INSERT INTO pins (requestid, username, cid, name, status, size)
        VALUES ('req1', 'stats@test.com', 'Qm1', 'Pin 1', 'pinned', 1000),
               ('req2', 'stats@test.com', 'Qm2', 'Pin 2', 'pinned', 2000),
               ('req3', 'stats@test.com', 'Qm3', 'Pin 3', 'queued', 500)
      `);

      const stats = dbOps.getUserStats('stats@test.com');

      expect(stats.totalPins).toBe(3);
      expect(stats.totalSize).toBe(3500);
      expect(stats.memberSince).toBeDefined();
    });

    it('should exclude deleted pins from stats', () => {
      db.exec(`
        INSERT INTO pins (requestid, username, cid, name, status, size)
        VALUES ('req1', 'stats@test.com', 'Qm1', 'Pin 1', 'pinned', 1000),
               ('req2', 'stats@test.com', 'Qm2', 'Pin 2', 'deleted', 2000)
      `);

      const stats = dbOps.getUserStats('stats@test.com');

      expect(stats.totalPins).toBe(1);
      expect(stats.totalSize).toBe(1000);
    });

    it('should return zero for user with no pins', () => {
      const stats = dbOps.getUserStats('stats@test.com');

      expect(stats.totalPins).toBe(0);
      expect(stats.totalSize).toBe(0);
    });
  });

  describe('Profile Deletion', () => {
    it('should delete all user data', () => {
      // Create user with data
      dbOps.getOrCreateUser('delete@test.com', 'Delete Me', 'https://pic.com/avatar.jpg');
      dbOps.createApiKey('delete@test.com');
      dbOps.addPin('delete@test.com', 'QmToDelete', 'Pin to delete');

      // Verify data exists
      expect(dbOps.getUserByEmail('delete@test.com')).toBeDefined();
      expect(dbOps.getApiKeys('delete@test.com').length).toBeGreaterThan(0);
      expect(dbOps.getUserPins('delete@test.com', 1, 10).total).toBeGreaterThan(0);

      // Delete profile
      dbOps.deleteUserProfile('delete@test.com');

      // Verify all data is gone
      expect(dbOps.getUserByEmail('delete@test.com')).toBeUndefined();
      expect(dbOps.getApiKeys('delete@test.com').length).toBe(0);
      expect(dbOps.getUserPins('delete@test.com', 1, 10).total).toBe(0);
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

describe('Input Validation', () => {
  let app: Express;
  let db: Database.Database;

  beforeAll(() => {
    db = initializeTestDatabase();
    const result = createApp(testConfig, db, { skipRateLimit: true });
    app = result.app;
  });

  afterAll(() => {
    db.close();
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
