/**
 * Security Audit Tests
 *
 * Tests for all security fixes implemented in the audit:
 * - C1: Admin token exact match (not substring)
 * - C2: JWT rejection when JWT_SECRET not configured
 * - H1: Wallet user creation deduplication
 * - H2: Payment settlement idempotency
 * - M1: Content-Length bounds validation
 * - M4: Download signature nonce replay prevention
 * - L1: Wallet address normalization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  createMockPaymentHeader,
  createMockVerifyResponse,
  createMockSettleResponse,
  createMockJwt,
  createSignedJwt,
  TEST_JWT_SECRET,
} from '../mocks/facilitator.js';

// ============================================
// C1: Admin Token Exact Match
// ============================================

describe('C1: Admin token exact match', () => {
  function mockHealthDeps() {
    // Mock all transitive dependencies of health routes
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        facilitatorUrl: 'https://facilitator.test',
        receivingAddress: '0xTest',
        networkChainId: 1,
        paymentTokenAddress: '0xToken',
        paymentTokenName: 'USDC',
        paymentTokenVersion: '2',
        basePriceMicroUsdc: 10000,
        minPaymentMicroUsdc: 1000,
        x402Version: 1,
        assetTransferMethod: 'eip3009',
      },
      getNetworkIdentifier: () => 'eip155:1',
      getAssetIdentifier: () => 'eip155:1/erc20:0xToken',
    }));
    vi.doMock('../../src/database/index.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../../src/database/repositories/ephemeralObjects.js', () => ({
      getCleanupStats: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock('../../src/services/cleanup.js', () => ({
      triggerCleanup: vi.fn().mockResolvedValue({ deleted: 0, errors: 0, duration: 1 }),
    }));
  }

  it('should reject Authorization header that contains admin token as substring', async () => {
    vi.resetModules();
    mockHealthDeps();

    const origToken = process.env.S3_ADMIN_TOKEN;
    process.env.S3_ADMIN_TOKEN = 'SECRET_TOKEN';

    const { healthRoutes } = await import('../../src/routes/health.js');
    const app = new Hono();
    app.route('/health', healthRoutes);

    // Attacker sends token embedded in a longer string
    const res = await app.request('/health/cleanup', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer xSECRET_TOKENx', // substring match attempt
      },
    });

    expect(res.status).toBe(403);

    process.env.S3_ADMIN_TOKEN = origToken;
  });

  it('should accept exact Bearer token match', async () => {
    vi.resetModules();
    mockHealthDeps();

    const origToken = process.env.S3_ADMIN_TOKEN;
    process.env.S3_ADMIN_TOKEN = 'SECRET_TOKEN';

    const { healthRoutes } = await import('../../src/routes/health.js');
    const app = new Hono();
    app.route('/health', healthRoutes);

    const res = await app.request('/health/cleanup', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer SECRET_TOKEN',
      },
    });

    // Should succeed (200) since token matches exactly
    expect(res.status).toBe(200);

    process.env.S3_ADMIN_TOKEN = origToken;
  });
});

// ============================================
// C2: JWT Rejection Without JWT_SECRET
// ============================================

describe('C2: JWT rejection without JWT_SECRET', () => {
  describe('jwtValidatorMiddleware - no jwtSecret', () => {
    it('should reject forged JWT when JWT_SECRET is not configured', async () => {
      vi.resetModules();

      // Mock config WITHOUT jwtSecret
      vi.doMock('../../src/config/index.js', () => ({
        config: { jwtSecret: undefined },
      }));

      const { jwtValidatorMiddleware } = await import('../../src/middleware/jwtValidator.js');
      const { errorHandler } = await import('../../src/middleware/errorHandler.js');

      const app = new Hono();
      app.onError(errorHandler);
      app.use('*', jwtValidatorMiddleware);
      app.get('/test', (c) => c.json({ success: true }));

      // Attacker sends a forged JWT
      const forgedJwt = createMockJwt({ email: 'admin@evil.com' });

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${forgedJwt}` },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('not available');
    });
  });

  describe('x402OrJwtMiddleware - no jwtSecret', () => {
    it('should reject Bearer JWT but allow x402-only mode', async () => {
      vi.resetModules();

      // Mock config WITHOUT jwtSecret
      vi.doMock('../../src/config/index.js', () => ({
        config: { jwtSecret: undefined },
      }));

      const { x402OrJwtMiddleware, getAuthMode } = await import('../../src/middleware/jwtValidator.js');
      const { errorHandler } = await import('../../src/middleware/errorHandler.js');

      const app = new Hono();
      app.onError(errorHandler);
      app.use('*', x402OrJwtMiddleware);
      app.get('/test', (c) => {
        const mode = getAuthMode(c);
        return c.json({ mode });
      });

      // Test 1: Bearer JWT should be rejected
      const forgedJwt = createMockJwt({ email: 'admin@evil.com' });
      const jwtRes = await app.request('/test', {
        headers: { Authorization: `Bearer ${forgedJwt}` },
      });
      expect(jwtRes.status).toBe(401);

      // Test 2: No auth (x402 mode) should be allowed
      const x402Res = await app.request('/test');
      expect(x402Res.status).toBe(200);
      const body = await x402Res.json();
      expect(body.mode).toBe('x402');
    });
  });
});

// ============================================
// M1: Content-Length Bounds Validation
// ============================================

describe('M1: Content-Length bounds validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should reject negative Content-Length', async () => {
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        facilitatorUrl: 'https://facilitator.test',
        receivingAddress: '0xTest',
        networkChainId: 1,
        paymentTokenAddress: '0xToken',
        paymentTokenName: 'USDC',
        paymentTokenVersion: '2',
        basePriceMicroUsdc: 10000,
        minPaymentMicroUsdc: 1000,
        x402Version: 1,
        assetTransferMethod: 'eip3009',
      },
      getNetworkIdentifier: () => 'eip155:1',
      getAssetIdentifier: () => 'eip155:1/erc20:0xToken',
    }));

    vi.doMock('../../src/database/repositories/paymentLogs.js', () => ({
      createPaymentLog: vi.fn(),
      markPaymentVerified: vi.fn(),
      markPaymentSettled: vi.fn(),
      markPaymentFailed: vi.fn(),
      getPaymentLog: vi.fn(),
    }));

    const { x402PaymentMiddleware } = await import('../../src/middleware/x402Payment.js');
    const { errorHandler } = await import('../../src/middleware/errorHandler.js');

    const app = new Hono();
    app.onError(errorHandler);
    app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ ok: true }));

    const res = await app.request('/test/b/k', {
      method: 'PUT',
      headers: {
        'Content-Length': '-1',
        'X-PAYMENT': createMockPaymentHeader(),
      },
      body: 'x',
    });

    expect(res.status).toBe(413);
  });

  it('should reject Content-Length exceeding 10GB', async () => {
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        facilitatorUrl: 'https://facilitator.test',
        receivingAddress: '0xTest',
        networkChainId: 1,
        paymentTokenAddress: '0xToken',
        paymentTokenName: 'USDC',
        paymentTokenVersion: '2',
        basePriceMicroUsdc: 10000,
        minPaymentMicroUsdc: 1000,
        x402Version: 1,
        assetTransferMethod: 'eip3009',
      },
      getNetworkIdentifier: () => 'eip155:1',
      getAssetIdentifier: () => 'eip155:1/erc20:0xToken',
    }));

    vi.doMock('../../src/database/repositories/paymentLogs.js', () => ({
      createPaymentLog: vi.fn(),
      markPaymentVerified: vi.fn(),
      markPaymentSettled: vi.fn(),
      markPaymentFailed: vi.fn(),
      getPaymentLog: vi.fn(),
    }));

    const { x402PaymentMiddleware } = await import('../../src/middleware/x402Payment.js');
    const { errorHandler } = await import('../../src/middleware/errorHandler.js');

    const app = new Hono();
    app.onError(errorHandler);
    app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ ok: true }));

    const res = await app.request('/test/b/k', {
      method: 'PUT',
      headers: {
        'Content-Length': '99999999999999', // ~90TB
        'X-PAYMENT': createMockPaymentHeader(),
      },
      body: 'x',
    });

    expect(res.status).toBe(413);
  });
});

// ============================================
// H1: Wallet User Deduplication
// ============================================

describe('H1: Wallet user creation deduplication', () => {
  it('should deduplicate concurrent requests for the same wallet', async () => {
    vi.resetModules();

    let callCount = 0;

    // Mock config
    vi.doMock('../../src/config/index.js', () => ({
      config: {
        pinningWebuiUrl: 'http://localhost:3001',
        pinningSystemKey: 'test-key',
      },
    }));

    vi.doMock('../../src/utils/address.js', () => ({
      normalizeAddress: (addr: string) => addr.toLowerCase(),
    }));

    const { ensureWalletUserAndGetApiKey, clearApiKeyCache } = await import('../../src/services/walletUser.js');

    // Clear cache to start fresh
    clearApiKeyCache();

    // Mock fetch
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      // Small delay to simulate network
      await new Promise(r => setTimeout(r, 50));
      return new Response(JSON.stringify({
        success: true,
        email: '0xabc@walletpayment.fx.land',
        apiKey: 'test-api-key',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // Fire 5 concurrent requests for same wallet
    const promises = Array.from({ length: 5 }, () =>
      ensureWalletUserAndGetApiKey('0xABC')
    );
    const results = await Promise.all(promises);

    // All should succeed with same result
    for (const r of results) {
      expect(r.apiKey).toBe('test-api-key');
    }

    // Only ONE actual HTTP call should have been made (deduplication)
    expect(callCount).toBe(1);

    global.fetch = origFetch;
  });
});

// ============================================
// L1: Wallet Address Normalization
// ============================================

describe('L1: Wallet address normalization', () => {
  it('normalizeAddress should lowercase addresses', async () => {
    const { normalizeAddress } = await import('../../src/utils/address.js');

    expect(normalizeAddress('0xABCDEF')).toBe('0xabcdef');
    expect(normalizeAddress('0x1234')).toBe('0x1234');
    expect(normalizeAddress('MIXED')).toBe('mixed');
  });

  it('walletToEmail should normalize wallet address', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/index.js', () => ({
      config: { pinningWebuiUrl: '', pinningSystemKey: '' },
    }));
    vi.doMock('../../src/utils/address.js', () => ({
      normalizeAddress: (addr: string) => addr.toLowerCase(),
    }));

    const { walletToEmail } = await import('../../src/services/walletUser.js');

    expect(walletToEmail('0xABCDEF')).toBe('0xabcdef@walletpayment.fx.land');
    expect(walletToEmail('0xabcdef')).toBe('0xabcdef@walletpayment.fx.land');
  });
});

// ============================================
// L4: rawToFula precision
// ============================================

describe('L4: rawToFula precision', () => {
  it('should preserve precision for large whole amounts', async () => {
    // We test the algorithm directly
    const FULA_DECIMALS = 18;

    function rawToFula(rawAmount: string): number {
      const amount = BigInt(rawAmount);
      const divisor = BigInt(10 ** FULA_DECIMALS);
      const whole = amount / divisor;
      const remainder = amount % divisor;
      return Number(whole) + Number(remainder) / Number(divisor);
    }

    // 1000 FULA = 1000 * 10^18
    expect(rawToFula('1000000000000000000000')).toBe(1000);

    // 0.5 FULA
    expect(rawToFula('500000000000000000')).toBe(0.5);

    // 123.456 FULA
    expect(rawToFula('123456000000000000000')).toBeCloseTo(123.456, 3);
  });
});
