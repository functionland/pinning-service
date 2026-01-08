/**
 * Integration Tests for x402 Payment Flow
 *
 * Tests the complete flow from client request to S3 proxy.
 * Verifies:
 * - Request format from client
 * - Request format to facilitator
 * - Request format to S3 backend
 * - Response formats at each stage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  createMockPaymentHeader,
  createMockVerifyResponse,
  createMockSettleResponse,
  createMockJwt,
  DEFAULT_MOCK_PAYMENT,
  encodeBase64,
  decodeBase64,
} from '../mocks/facilitator.js';

// Mock config
vi.mock('../../src/config/index.js', () => ({
  config: {
    port: 4002,
    nodeEnv: 'test',
    facilitatorUrl: 'https://facilitator.test',
    receivingAddress: '0xReceiverAddress1234567890123456789012',
    networkChainId: 324705682,
    paymentTokenAddress: '0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
    paymentTokenName: 'Bridged USDC (SKALE Bridge)',
    s3BackendUrl: 'http://s3.test:9000',
    pinningWebuiUrl: 'http://pinning.test:3001',
    pinningSystemKey: 'test-system-key',
    databasePath: ':memory:',
    basePriceMicroUsdc: 10000,
    minPaymentMicroUsdc: 1000,
    fulaExchangeRate: 1.0,
    jwtSecret: undefined,
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

vi.mock('../../src/database/repositories/ephemeralObjects.js', () => ({
  trackEphemeralObject: vi.fn(),
}));

// Import after mocking
import { s3ProxyRoutes } from '../../src/routes/s3Proxy.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

/**
 * Helper to create a test app with s3ProxyRoutes and error handler
 */
function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.route('/', s3ProxyRoutes);
  return app;
}

describe('x402 Flow Integration Tests', () => {
  let originalFetch: typeof fetch;
  let fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }>;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /**
   * Setup mock fetch that tracks all calls
   */
  function setupMockFetch(options: {
    verifySuccess?: boolean;
    settleSuccess?: boolean;
    s3Success?: boolean;
    s3Cid?: string;
    pinningSuccess?: boolean;
  } = {}) {
    const {
      verifySuccess = true,
      settleSuccess = true,
      s3Success = true,
      s3Cid = 'QmTestCid123',
      pinningSuccess = true,
    } = options;

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Headers | Record<string, string>;
        if (h instanceof Headers) {
          h.forEach((value, key) => { headers[key] = value; });
        } else {
          Object.assign(headers, h);
        }
      }

      fetchCalls.push({
        url,
        method: init?.method || 'GET',
        headers,
        body: init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : undefined,
      });

      // Facilitator /verify
      if (url.includes('/verify')) {
        return new Response(JSON.stringify(createMockVerifyResponse({
          verifySuccess,
          payment: DEFAULT_MOCK_PAYMENT,
        })), {
          status: verifySuccess ? 200 : 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Facilitator /settle
      if (url.includes('/settle')) {
        return new Response(JSON.stringify(createMockSettleResponse({
          settleSuccess,
        })), {
          status: settleSuccess ? 200 : 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // S3 backend
      if (url.includes('s3.test')) {
        if (s3Success) {
          return new Response(JSON.stringify({ cid: s3Cid }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'ETag': `"${s3Cid}"`,
            },
          });
        }
        return new Response('S3 Error', { status: 500 });
      }

      // Pinning service
      if (url.includes('pinning.test')) {
        if (pinningSuccess) {
          return new Response(JSON.stringify({
            success: true,
            newBalance: 100,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Pinning Error', { status: 500 });
      }

      return new Response('Not Found', { status: 404 });
    });
  }

  describe('Complete Upload Flow', () => {
    it('should handle successful upload with payment', async () => {
      setupMockFetch();

      const app = createTestApp();

      const jwt = createMockJwt({
        wallet: DEFAULT_MOCK_PAYMENT.payer,
        email: 'test@example.com',
      });

      const res = await app.request('/mybucket/path/to/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
          'X-Fula-TTL': '3600',
        },
        body: 'test content',
      });

      expect(res.status).toBe(200);

      // Verify response body
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.bucket).toBe('mybucket');
      expect(body.key).toBe('path/to/file.txt');
      expect(body.cid).toBeDefined();
      expect(body.expires_at).toBeDefined();
    });

    it('should pass JWT to S3 backend', async () => {
      setupMockFetch();

      const app = createTestApp();

      const jwt = createMockJwt({
        wallet: DEFAULT_MOCK_PAYMENT.payer,
      });

      await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      // Find S3 call
      const s3Call = fetchCalls.find(c => c.url.includes('s3.test'));
      expect(s3Call).toBeDefined();
      expect(s3Call!.headers['Authorization']).toBe(`Bearer ${jwt}`);
    });

    it('should include wallet metadata in S3 request', async () => {
      setupMockFetch();

      const app = createTestApp();

      const jwt = createMockJwt({
        wallet: DEFAULT_MOCK_PAYMENT.payer,
      });

      await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
          'X-Fula-TTL': '7200',
        },
        body: 'test',
      });

      const s3Call = fetchCalls.find(c => c.url.includes('s3.test'));
      expect(s3Call).toBeDefined();
      expect(s3Call!.headers['X-Amz-Meta-Wallet']).toBe(DEFAULT_MOCK_PAYMENT.payer.toLowerCase());
      expect(s3Call!.headers['X-Amz-Meta-Payment-Id']).toBeDefined();
      expect(s3Call!.headers['X-Amz-Meta-Ttl-Seconds']).toBe('7200');
    });
  });

  describe('Facilitator Request Format', () => {
    it('should send correct verify request to facilitator', async () => {
      setupMockFetch();

      const app = createTestApp();

      const jwt = createMockJwt({ wallet: DEFAULT_MOCK_PAYMENT.payer });

      await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '10485760', // 10 MB
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
          'X-Fula-TTL': '3600',
        },
        body: 'test',
      });

      const verifyCall = fetchCalls.find(c => c.url.includes('/verify'));
      expect(verifyCall).toBeDefined();
      expect(verifyCall!.method).toBe('POST');
      expect(verifyCall!.headers['Content-Type']).toBe('application/json');

      // Verify request body structure
      const verifyBody = verifyCall!.body as {
        payload: string;
        details: {
          scheme: string;
          network: string;
          maxAmountRequired: string;
          payTo: string;
          asset: string;
        };
      };

      expect(verifyBody.payload).toBeDefined();
      expect(verifyBody.details.scheme).toBe('exact');
      expect(verifyBody.details.network).toBe('eip155:324705682');
      expect(verifyBody.details.payTo).toBe('0xReceiverAddress1234567890123456789012');
      expect(verifyBody.details.asset).toBe('eip155:324705682/erc20:0x2e08028E3C4c2356572E096d8EF835cD5C6030bD');
      // 10 MB × 1 hour × $0.01 = $0.10 = 100000 µUSDC
      expect(verifyBody.details.maxAmountRequired).toBe('100000');
    });

    it('should send correct settle request to facilitator', async () => {
      setupMockFetch();

      const app = createTestApp();

      const jwt = createMockJwt({ wallet: DEFAULT_MOCK_PAYMENT.payer });

      await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      const settleCall = fetchCalls.find(c => c.url.includes('/settle'));
      expect(settleCall).toBeDefined();
      expect(settleCall!.method).toBe('POST');

      const settleBody = settleCall!.body as { payload: string };
      expect(settleBody.payload).toBeDefined();
    });
  });

  describe('402 Payment Required Response', () => {
    it('should return 402 with correct headers when no payment', async () => {
      const app = createTestApp();

      const jwt = createMockJwt();

      const res = await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '10485760', // 10 MB
          'Content-Type': 'application/octet-stream',
          'X-Fula-TTL': '3600',
        },
        body: 'test',
      });

      expect(res.status).toBe(402);

      // Verify X-PAYMENT-REQUIRED header
      const paymentRequiredHeader = res.headers.get('X-PAYMENT-REQUIRED');
      expect(paymentRequiredHeader).not.toBeNull();

      const paymentRequired = decodeBase64<{
        x402Version: number;
        accepts: Array<{
          scheme: string;
          network: string;
          maxAmountRequired: string;
          payTo: string;
          asset: string;
          description: string;
          resource: string;
          extra: {
            facilitatorUrl: string;
            name: string;
            version: string;
          };
        }>;
      }>(paymentRequiredHeader!);

      // Verify structure matches x402 standard
      expect(paymentRequired.x402Version).toBe(1);
      expect(paymentRequired.accepts).toHaveLength(1);

      const accept = paymentRequired.accepts[0];
      expect(accept.scheme).toBe('exact');
      expect(accept.network).toBe('eip155:324705682');
      expect(accept.maxAmountRequired).toBe('100000'); // 10 MB × 1 hour
      expect(accept.payTo).toBe('0xReceiverAddress1234567890123456789012');
      expect(accept.asset).toContain('eip155:324705682/erc20:');
      expect(accept.description).toContain('Storage');
      expect(accept.extra.facilitatorUrl).toBe('https://facilitator.test');
    });

    it('should include body matching header in 402 response', async () => {
      const app = createTestApp();

      const jwt = createMockJwt();

      const res = await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
        },
        body: 'test',
      });

      expect(res.status).toBe(402);

      const body = await res.json();
      expect(body.x402Version).toBe(1);
      expect(body.accepts).toBeDefined();
      expect(body.error).toBe('Payment Required');
    });
  });

  describe('Error Handling', () => {
    it('should return 401 when no JWT provided', async () => {
      const app = createTestApp();

      const res = await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(res.status).toBe(401);
    });

    it('should return 402 when facilitator verification fails', async () => {
      setupMockFetch({ verifySuccess: false });

      const app = createTestApp();

      const jwt = createMockJwt({ wallet: DEFAULT_MOCK_PAYMENT.payer });

      const res = await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      expect(res.status).toBe(402);
    });

    it('should return 403 when JWT wallet does not match payment wallet', async () => {
      setupMockFetch();

      const app = createTestApp();

      // JWT with different wallet
      const jwt = createMockJwt({
        wallet: '0xDifferentWallet12345678901234567890AB',
      });

      const res = await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(), // Uses DEFAULT_MOCK_PAYMENT.payer
        },
        body: 'test',
      });

      expect(res.status).toBe(403);
    });

    it('should handle S3 backend errors', async () => {
      setupMockFetch({ s3Success: false });

      const app = createTestApp();

      const jwt = createMockJwt({ wallet: DEFAULT_MOCK_PAYMENT.payer });

      const res = await app.request('/mybucket/file.txt', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Length': '1048576',
          'Content-Type': 'application/octet-stream',
          'X-PAYMENT': createMockPaymentHeader(),
        },
        body: 'test',
      });

      // Should return error for S3 error (502 or 500 depending on error type)
      expect([500, 502]).toContain(res.status);
    });
  });

  describe('GET and HEAD Requests', () => {
    it('should pass through GET requests to S3', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        fetchCalls.push({
          url,
          method: init?.method || 'GET',
          headers: {},
        });

        if (url.includes('s3.test')) {
          return new Response('file content', {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();

      const res = await app.request('/mybucket/file.txt', {
        method: 'GET',
      });

      expect(res.status).toBe(200);

      // Should have called S3 backend
      const s3Call = fetchCalls.find(c => c.url.includes('s3.test'));
      expect(s3Call).toBeDefined();
      expect(s3Call!.method).toBe('GET');
    });

    it('should pass through JWT for GET if provided', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = init.headers as Record<string, string>;
          Object.assign(headers, h);
        }

        fetchCalls.push({
          url,
          method: init?.method || 'GET',
          headers,
        });

        if (url.includes('s3.test')) {
          return new Response('file content', {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();

      const jwt = createMockJwt();

      await app.request('/mybucket/private-file.txt', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${jwt}`,
        },
      });

      const s3Call = fetchCalls.find(c => c.url.includes('s3.test'));
      expect(s3Call!.headers['Authorization']).toBe(`Bearer ${jwt}`);
    });

    it('should handle HEAD requests', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        fetchCalls.push({
          url,
          method: init?.method || 'GET',
          headers: {},
        });

        if (url.includes('s3.test')) {
          return new Response(null, {
            status: 200,
            headers: {
              'Content-Length': '1024',
              'Content-Type': 'application/octet-stream',
            },
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const app = createTestApp();

      const res = await app.request('/mybucket/file.txt', {
        method: 'HEAD',
      });

      expect(res.status).toBe(200);

      const s3Call = fetchCalls.find(c => c.url.includes('s3.test'));
      // Hono may handle HEAD internally, so we just check the request was made
      expect(s3Call).toBeDefined();
    });
  });

  describe('DELETE Requests', () => {
    it('should require JWT and payment for DELETE', async () => {
      setupMockFetch();

      const app = createTestApp();

      const jwt = createMockJwt({ wallet: DEFAULT_MOCK_PAYMENT.payer });

      const res = await app.request('/mybucket/file.txt', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'X-PAYMENT': createMockPaymentHeader(),
          'Content-Length': '0', // Required for x402 middleware to calculate price
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 402 for DELETE without payment', async () => {
      const app = createTestApp();

      const jwt = createMockJwt();

      const res = await app.request('/mybucket/file.txt', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${jwt}`,
        },
      });

      expect(res.status).toBe(402);
    });
  });
});
