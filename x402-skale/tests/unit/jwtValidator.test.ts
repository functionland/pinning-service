/**
 * Unit Tests for JWT Validator Middleware
 *
 * Tests JWT parsing, validation, and wallet extraction.
 * Updated for C2 security fix: JWT auth now requires JWT_SECRET to be configured.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSignedJwt, createMockJwt, TEST_JWT_SECRET } from '../mocks/facilitator.js';

// Mock config with jwtSecret set (C2: JWT auth requires configured secret)
vi.mock('../../src/config/index.js', () => ({
  config: {
    jwtSecret: 'test-jwt-secret-for-unit-tests-32ch',
  },
}));

// Import after mocking
import {
  jwtValidatorMiddleware,
  x402OrJwtMiddleware,
  walletAssertionMiddleware,
  optionalJwtMiddleware,
  getJwtUser,
  getAuthMode,
} from '../../src/middleware/jwtValidator.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

/**
 * Helper to create a test app with error handler
 */
function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe('JWT Validator Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('jwtValidatorMiddleware', () => {
    it('should return 401 when no Authorization header', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Missing');
    });

    it('should return 401 when Authorization header is not Bearer', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', {
        headers: {
          Authorization: 'Basic dGVzdDp0ZXN0',
        },
      });

      expect(res.status).toBe(401);
    });

    it('should extract email from signed JWT claims', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        return c.json({ email: user?.email });
      });

      const jwt = await createSignedJwt({ email: 'test@example.com' });

      const res = await app.request('/test', {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email).toBe('test@example.com');
    });

    it('should extract wallet from signed JWT claims', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        return c.json({ wallet: user?.wallet });
      });

      const jwt = await createSignedJwt({
        wallet: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      });

      const res = await app.request('/test', {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Should be lowercase
      expect(body.wallet).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

    it('should return 401 for expired JWT', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      // Create signed JWT with past expiration
      const jwt = await createSignedJwt({
        exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      });

      const res = await app.request('/test', {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.status).toBe(401);
    });

    it('should return 401 for unsigned/forged JWT (C2 security fix)', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      // Use unsigned mock JWT — should be rejected because jwtSecret IS configured
      const jwt = createMockJwt({ email: 'attacker@evil.com' });

      const res = await app.request('/test', {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.status).toBe(401);
    });

    it('should return 401 for malformed JWT', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', {
        headers: {
          Authorization: 'Bearer not-a-valid-jwt',
        },
      });

      expect(res.status).toBe(401);
    });

    it('should extract subject from signed JWT claims', async () => {
      const app = createTestApp();
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        return c.json({ sub: user?.sub });
      });

      const jwt = await createSignedJwt({ sub: 'user-456' });

      const res = await app.request('/test', {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sub).toBe('user-456');
    });
  });

  describe('x402OrJwtMiddleware (C2 security)', () => {
    it('should accept signed JWT and set authMode to jwt', async () => {
      const app = createTestApp();
      app.use('*', x402OrJwtMiddleware);
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        const mode = getAuthMode(c);
        return c.json({ email: user?.email, mode });
      });

      const jwt = await createSignedJwt({ email: 'jwt-user@example.com' });

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email).toBe('jwt-user@example.com');
      expect(body.mode).toBe('jwt');
    });

    it('should reject unsigned JWT even in x402-or-jwt mode', async () => {
      const app = createTestApp();
      app.use('*', x402OrJwtMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const jwt = createMockJwt({ email: 'forged@evil.com' });

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(401);
    });

    it('should fall through to x402 mode when no Authorization header', async () => {
      const app = createTestApp();
      app.use('*', x402OrJwtMiddleware);
      app.get('/test', (c) => {
        const mode = getAuthMode(c);
        return c.json({ mode });
      });

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('x402');
    });
  });

  describe('walletAssertionMiddleware', () => {
    it('should pass when JWT wallet matches x402 wallet', async () => {
      const app = createTestApp();
      app.use('*', async (c, next) => {
        c.set('jwtUser', {
          email: 'test@example.com',
          wallet: '0x1234567890123456789012345678901234567890',
        });
        c.set('x402Payment', {
          payer: '0x1234567890123456789012345678901234567890',
        });
        await next();
      });
      app.use('*', walletAssertionMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(200);
    });

    it('should fail when JWT wallet does not match x402 wallet', async () => {
      const app = createTestApp();
      app.use('*', async (c, next) => {
        c.set('jwtUser', {
          email: 'test@example.com',
          wallet: '0x1111111111111111111111111111111111111111',
        });
        c.set('x402Payment', {
          payer: '0x2222222222222222222222222222222222222222',
        });
        await next();
      });
      app.use('*', walletAssertionMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('mismatch');
    });

    it('should pass when JWT has no wallet (no assertion)', async () => {
      const app = createTestApp();
      app.use('*', async (c, next) => {
        c.set('jwtUser', {
          email: 'test@example.com',
        });
        c.set('x402Payment', {
          payer: '0x2222222222222222222222222222222222222222',
        });
        await next();
      });
      app.use('*', walletAssertionMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(200);
    });

    it('should be case insensitive for wallet comparison', async () => {
      const app = createTestApp();
      app.use('*', async (c, next) => {
        c.set('jwtUser', {
          email: 'test@example.com',
          wallet: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        });
        c.set('x402Payment', {
          payer: '0xabcdef1234567890abcdef1234567890abcdef12',
        });
        await next();
      });
      app.use('*', walletAssertionMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(200);
    });
  });

  describe('optionalJwtMiddleware', () => {
    it('should pass without JWT', async () => {
      const app = createTestApp();
      app.use('*', optionalJwtMiddleware);
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        return c.json({ hasUser: !!user });
      });

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hasUser).toBe(false);
    });

    it('should extract user when valid JWT provided', async () => {
      const app = createTestApp();
      app.use('*', optionalJwtMiddleware);
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        return c.json({ email: user?.email });
      });

      // optionalJwtMiddleware uses decode-only (no verify), so unsigned is fine
      const jwt = createMockJwt({ email: 'optional@test.com' });

      const res = await app.request('/test', {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email).toBe('optional@test.com');
    });

    it('should ignore invalid JWT silently', async () => {
      const app = createTestApp();
      app.use('*', optionalJwtMiddleware);
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        return c.json({ hasUser: !!user });
      });

      const res = await app.request('/test', {
        headers: {
          Authorization: 'Bearer invalid-jwt',
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hasUser).toBe(false);
    });
  });

  describe('getJwtUser helper', () => {
    it('should return undefined when no user in context', async () => {
      const app = createTestApp();
      app.get('/test', (c) => {
        const user = getJwtUser(c);
        return c.json({ user: user ?? null });
      });

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeNull();
    });
  });
});
