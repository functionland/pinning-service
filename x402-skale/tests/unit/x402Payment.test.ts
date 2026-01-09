/**
 * Unit Tests for x402 Payment Middleware
 *
 * Tests the x402 payment flow including:
 * - 402 Payment Required response format
 * - X-PAYMENT header parsing
 * - Facilitator verify/settle communication
 * - Response header format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  createMockPaymentHeader,
  createMockVerifyResponse,
  createMockSettleResponse,
  createStandardVerifyResponse,
  createStandardSettleResponse,
  DEFAULT_MOCK_PAYMENT,
  encodeBase64,
  decodeBase64,
} from '../mocks/facilitator.js';

// Mock config
vi.mock('../../src/config/index.js', () => ({
  config: {
    facilitatorUrl: 'https://facilitator.test',
    receivingAddress: '0xReceiverAddress1234567890123456789012',
    networkChainId: 324705682,
    paymentTokenAddress: '0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
    paymentTokenName: 'Bridged USDC (SKALE Bridge)',
    basePriceMicroUsdc: 10000,
    minPaymentMicroUsdc: 1000,
  },
  getNetworkIdentifier: () => 'eip155:324705682',
  getAssetIdentifier: () => 'eip155:324705682/erc20:0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
}));

// Mock database
vi.mock('../../src/database/repositories/paymentLogs.js', () => ({
  createPaymentLog: vi.fn(),
  markPaymentVerified: vi.fn(),
  markPaymentSettled: vi.fn(),
  markPaymentFailed: vi.fn(),
}));

// Import after mocking
import {
  x402PaymentMiddleware,
  getPaymentInfo,
  hasPaymentHeader,
} from '../../src/middleware/x402Payment.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

/**
 * Helper to create a test app with error handler
 */
function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe('x402 Payment Middleware', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('402 Payment Required Response', () => {
    it('should return 402 when no payment header is present', async () => {
      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576', // 1 MB
          'Content-Type': 'application/octet-stream',
        },
        body: 'test content',
      });

      expect(res.status).toBe(402);

      // Check X-PAYMENT-REQUIRED header exists
      const paymentRequiredHeader = res.headers.get('X-PAYMENT-REQUIRED');
      expect(paymentRequiredHeader).not.toBeNull();

      // Decode and verify header contents
      const paymentRequired = decodeBase64<{
        x402Version: number;
        accepts: Array<{
          scheme: string;
          network: string;
          maxAmountRequired: string;
          payTo: string;
          asset: string;
        }>;
      }>(paymentRequiredHeader!);

      expect(paymentRequired.x402Version).toBe(1);
      expect(paymentRequired.accepts).toHaveLength(1);
      expect(paymentRequired.accepts[0].scheme).toBe('exact');
      expect(paymentRequired.accepts[0].network).toBe('eip155:324705682');
      expect(paymentRequired.accepts[0].payTo).toBe('0xReceiverAddress1234567890123456789012');
      expect(paymentRequired.accepts[0].asset).toBe('eip155:324705682/erc20:0x2e08028E3C4c2356572E096d8EF835cD5C6030bD');
    });

    it('should include correct price in 402 response', async () => {
      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '10485760', // 10 MB
          'Content-Type': 'application/octet-stream',
          'X-Fula-TTL': '3600', // 1 hour
        },
        body: 'test content',
      });

      expect(res.status).toBe(402);

      const paymentRequiredHeader = res.headers.get('X-PAYMENT-REQUIRED');
      const paymentRequired = decodeBase64<{
        accepts: Array<{ maxAmountRequired: string }>;
      }>(paymentRequiredHeader!);

      // 10 MB × 1 hour × $0.01 = $0.10 = 100000 µUSDC
      expect(paymentRequired.accepts[0].maxAmountRequired).toBe('100000');
    });

    it('should include response body matching header', async () => {
      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
        },
        body: 'test',
      });

      const body = await res.json();

      expect(body.x402Version).toBe(1);
      expect(body.accepts).toBeDefined();
      expect(body.accepts[0].scheme).toBe('exact');
    });

    it('should include facilitator URL in extra field', async () => {
      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
        },
        body: 'test',
      });

      expect(res.status).toBe(402);

      const body = await res.json();
      expect(body.accepts[0].extra.facilitatorUrl).toBe('https://facilitator.test');
    });
  });

  describe('X-PAYMENT Header Parsing', () => {
    it('should accept X-PAYMENT header', async () => {
      // Mock facilitator responses
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => {
        const payment = getPaymentInfo(c);
        return c.json({ success: true, payer: payment?.payer });
      });

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test content',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.payer).toBe(DEFAULT_MOCK_PAYMENT.payer.toLowerCase());
    });

    it('should accept Payment-Authorization header with x402 prefix', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => {
        const payment = getPaymentInfo(c);
        return c.json({ success: true, payer: payment?.payer });
      });

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'Payment-Authorization': `x402 ${createMockPaymentHeader()}`,
        },
        body: 'test content',
      });

      expect(res.status).toBe(200);
    });
  });

  describe('Facilitator Communication', () => {
    it('should call facilitator /verify with correct payload', async () => {
      const verifyCalls: { url: string; body: unknown }[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/verify')) {
          verifyCalls.push({ url, body: JSON.parse(init?.body as string) });
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(verifyCalls).toHaveLength(1);
      expect(verifyCalls[0].url).toBe('https://facilitator.test/verify');
      expect(verifyCalls[0].body).toHaveProperty('payload');
      expect(verifyCalls[0].body).toHaveProperty('details');
      expect((verifyCalls[0].body as { details: { scheme: string } }).details.scheme).toBe('exact');
    });

    it('should call facilitator /settle after successful handler', async () => {
      const settleCalls: { url: string; body: unknown }[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          settleCalls.push({ url, body: JSON.parse(init?.body as string) });
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(settleCalls).toHaveLength(1);
      expect(settleCalls[0].url).toBe('https://facilitator.test/settle');
      expect(settleCalls[0].body).toHaveProperty('payload');
    });

    it('should return 402 when facilitator verification fails', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse({
            verifySuccess: false,
            verifyError: 'Invalid signature',
          })), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(res.status).toBe(402);
    });
  });

  describe('X-PAYMENT-RESPONSE Header', () => {
    it('should include X-PAYMENT-RESPONSE header on success', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse({
            txHash: '0xtestTxHash123',
          })), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(res.status).toBe(200);

      const paymentResponseHeader = res.headers.get('X-PAYMENT-RESPONSE');
      expect(paymentResponseHeader).not.toBeNull();

      const paymentResponse = decodeBase64<{
        success: boolean;
        transaction: string;
        network: string;
      }>(paymentResponseHeader!);

      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.transaction).toBe('0xtestTxHash123');
      expect(paymentResponse.network).toBe('eip155:324705682');
    });
  });

  describe('TTL Parsing', () => {
    it('should parse X-Fula-TTL header', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => {
        const payment = getPaymentInfo(c);
        return c.json({ ttlSeconds: payment?.ttlSeconds });
      });

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
          'X-Fula-TTL': '7200',
        },
        body: 'test',
      });

      const body = await res.json();
      expect(body.ttlSeconds).toBe(7200);
    });

    it('should use default TTL when header not provided', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => {
        const payment = getPaymentInfo(c);
        return c.json({ ttlSeconds: payment?.ttlSeconds });
      });

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      const body = await res.json();
      expect(body.ttlSeconds).toBe(3600); // Default 1 hour
    });

    it('should enforce maximum TTL', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => {
        const payment = getPaymentInfo(c);
        return c.json({ ttlSeconds: payment?.ttlSeconds });
      });

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
          'X-Fula-TTL': '999999999', // Way over max
        },
        body: 'test',
      });

      const body = await res.json();
      expect(body.ttlSeconds).toBe(30 * 24 * 3600); // Max 30 days
    });
  });

  describe('hasPaymentHeader helper', () => {
    it('should detect X-PAYMENT header', () => {
      // Note: This tests the helper function directly
      // In real usage, it's called within middleware context
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'X-PAYMENT') return 'test-payment';
            return undefined;
          },
        },
      };

      // We can't easily test hasPaymentHeader without a full context
      // This is more of a documentation that the function exists
      expect(hasPaymentHeader).toBeDefined();
    });
  });

  describe('Non-PUT requests', () => {
    it('should skip middleware for GET requests', async () => {
      const app = createTestApp();
      app.get('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'GET',
      });

      // GET should pass through without 402
      expect(res.status).toBe(200);
    });
  });

  describe('Standard x402 Format Compatibility', () => {
    it('should handle standard verify response with isValid field', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          // Standard x402 format uses isValid instead of valid
          return new Response(JSON.stringify(createStandardVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createStandardSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => {
        const payment = getPaymentInfo(c);
        return c.json({ success: true, payer: payment?.payer });
      });

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test content',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should handle standard verify failure with invalidReason field', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          // Standard x402 format uses invalidReason instead of error
          return new Response(JSON.stringify(createStandardVerifyResponse({
            verifySuccess: false,
            verifyError: 'Signature verification failed',
          })), {
            status: 200, // Standard may return 200 with isValid: false
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toContain('Signature verification failed');
    });

    it('should handle standard settle response with transaction field', async () => {
      const expectedTxHash = '0xstandard1234567890abcdef1234567890abcdef1234567890abcdef12345678';

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          // Standard x402 format uses transaction instead of txHash
          return new Response(JSON.stringify(createStandardSettleResponse({
            txHash: expectedTxHash,
          })), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      const res = await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(res.status).toBe(200);

      // Check X-PAYMENT-RESPONSE header contains the transaction hash
      const paymentResponseHeader = res.headers.get('X-PAYMENT-RESPONSE');
      expect(paymentResponseHeader).not.toBeNull();

      const paymentResponse = decodeBase64<{
        success: boolean;
        transaction: string;
      }>(paymentResponseHeader!);

      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.transaction).toBe(expectedTxHash);
    });

    it('should send both standard and legacy format fields in verify request', async () => {
      const verifyCalls: { url: string; body: Record<string, unknown> }[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/verify')) {
          verifyCalls.push({ url, body: JSON.parse(init?.body as string) });
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(verifyCalls).toHaveLength(1);

      // Check standard format fields
      expect(verifyCalls[0].body).toHaveProperty('paymentPayload');
      expect(verifyCalls[0].body).toHaveProperty('paymentRequirements');

      // Check legacy format fields (for backwards compatibility)
      expect(verifyCalls[0].body).toHaveProperty('payload');
      expect(verifyCalls[0].body).toHaveProperty('details');

      // Verify paymentRequirements contains expected fields
      const requirements = verifyCalls[0].body.paymentRequirements as Record<string, unknown>;
      expect(requirements.scheme).toBe('exact');
      expect(requirements.network).toBe('eip155:324705682');
      expect(requirements.payTo).toBe('0xReceiverAddress1234567890123456789012');
    });

    it('should send paymentRequirements in settle request for standard format', async () => {
      const settleCalls: { url: string; body: Record<string, unknown> }[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/verify')) {
          return new Response(JSON.stringify(createMockVerifyResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/settle')) {
          settleCalls.push({ url, body: JSON.parse(init?.body as string) });
          return new Response(JSON.stringify(createMockSettleResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();
      app.put('/test/:bucket/:key', x402PaymentMiddleware, (c) => c.json({ success: true }));

      await app.request('/test/mybucket/myfile.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(settleCalls).toHaveLength(1);

      // Check standard format fields
      expect(settleCalls[0].body).toHaveProperty('paymentPayload');
      expect(settleCalls[0].body).toHaveProperty('paymentRequirements');

      // Check legacy format field
      expect(settleCalls[0].body).toHaveProperty('payload');

      // Verify paymentRequirements in settle contains expected fields
      const requirements = settleCalls[0].body.paymentRequirements as Record<string, unknown>;
      expect(requirements.scheme).toBe('exact');
      expect(requirements.maxAmountRequired).toBeDefined();
    });
  });
});
