/**
 * Mock Facilitator for Testing
 *
 * Simulates the x402 facilitator's /verify and /settle endpoints.
 */

export interface MockPayment {
  paymentId: string;
  payer: string;
  amount: string;
  asset: string;
  network: string;
  chainId?: number;
  payTo?: string;
}

export interface MockFacilitatorOptions {
  /** Whether verification should succeed */
  verifySuccess?: boolean;
  /** Whether settlement should succeed */
  settleSuccess?: boolean;
  /** Custom error message for verification */
  verifyError?: string;
  /** Custom error message for settlement */
  settleError?: string;
  /** Transaction hash to return on settlement */
  txHash?: string;
  /** Payment data to return */
  payment?: MockPayment;
}

/**
 * Default mock payment data
 */
export const DEFAULT_MOCK_PAYMENT: MockPayment = {
  paymentId: 'test-payment-123',
  payer: '0x1234567890123456789012345678901234567890',
  amount: '10000',
  asset: 'eip155:324705682/erc20:0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
  network: 'eip155:324705682',
  chainId: 324705682,
  payTo: '0xReceiverAddress1234567890123456789012',
};

/**
 * Create a mock facilitator verify response (legacy format)
 */
export function createMockVerifyResponse(options: MockFacilitatorOptions = {}) {
  const {
    verifySuccess = true,
    verifyError,
    payment = DEFAULT_MOCK_PAYMENT,
  } = options;

  if (verifySuccess) {
    return {
      valid: true,
      paymentId: payment.paymentId,
      payer: payment.payer,
      amount: payment.amount,
      asset: payment.asset,
      network: payment.network,
    };
  }

  return {
    valid: false,
    error: verifyError || 'Invalid payment signature',
  };
}

/**
 * Create a mock facilitator verify response (standard x402 format)
 * Uses isValid instead of valid, invalidReason instead of error
 */
export function createStandardVerifyResponse(options: MockFacilitatorOptions = {}) {
  const {
    verifySuccess = true,
    verifyError,
  } = options;

  if (verifySuccess) {
    return {
      isValid: true,
    };
  }

  return {
    isValid: false,
    invalidReason: verifyError || 'Invalid payment signature',
  };
}

/**
 * Create a mock facilitator settle response (legacy format)
 */
export function createMockSettleResponse(options: MockFacilitatorOptions = {}) {
  const {
    settleSuccess = true,
    settleError,
    txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  } = options;

  if (settleSuccess) {
    return {
      success: true,
      txHash,
    };
  }

  return {
    success: false,
    error: settleError || 'Settlement failed',
  };
}

/**
 * Create a mock facilitator settle response (standard x402 format)
 * Uses transaction instead of txHash, includes network
 */
export function createStandardSettleResponse(options: MockFacilitatorOptions & { network?: string } = {}) {
  const {
    settleSuccess = true,
    settleError,
    txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    network = 'eip155:324705682',
  } = options;

  if (settleSuccess) {
    return {
      success: true,
      transaction: txHash,
      network,
    };
  }

  return {
    success: false,
    error: settleError || 'Settlement failed',
  };
}

/**
 * Create a valid mock X-PAYMENT header (base64 encoded) - v2 format
 */
export function createMockPaymentHeader(payment: MockPayment = DEFAULT_MOCK_PAYMENT): string {
  // This is a simplified mock - real headers would contain a signature
  const payload = {
    paymentId: payment.paymentId,
    payer: payment.payer,
    amount: payment.amount,
    asset: payment.asset,
    network: payment.network,
    signature: 'mock-signature',
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Create a mock X-PAYMENT header for v1 (Corbits) format
 * v1 uses a different payload structure with authorization details
 */
export function createMockPaymentHeaderV1(payment: MockPayment = DEFAULT_MOCK_PAYMENT): string {
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: `eip155:${payment.chainId || 324705682}`,
    asset: payment.asset,
    payload: {
      signature: '0xmocksignature1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      authorization: {
        from: payment.payer,
        to: payment.payTo || '0xReceiverAddress1234567890123456789012',
        value: payment.amount,
        validAfter: String(Math.floor(Date.now() / 1000) - 60),
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: '0xmocknonce1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Create mock fetch for facilitator endpoints
 */
export function createMockFacilitator(options: MockFacilitatorOptions = {}): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.endsWith('/verify')) {
      const response = createMockVerifyResponse(options);
      return new Response(JSON.stringify(response), {
        status: response.valid ? 200 : 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/settle')) {
      const response = createMockSettleResponse(options);
      return new Response(JSON.stringify(response), {
        status: response.success ? 200 : 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Unknown endpoint
    return new Response('Not Found', { status: 404 });
  };
}

/**
 * Mock S3 backend response
 */
export interface MockS3Options {
  success?: boolean;
  status?: number;
  cid?: string;
  error?: string;
}

/**
 * Create mock S3 response
 */
export function createMockS3Response(options: MockS3Options = {}) {
  const {
    success = true,
    status = 200,
    cid = 'QmTest1234567890abcdefghijklmnopqrstuvwxyz',
    error,
  } = options;

  if (success) {
    return {
      success: true,
      status,
      cid,
      headers: {
        'content-type': 'application/octet-stream',
        etag: `"${cid}"`,
      },
    };
  }

  return {
    success: false,
    status: status || 500,
    error: error || 'S3 error',
  };
}

/**
 * Encode object to base64 (x402 header format)
 */
export function encodeBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

/**
 * Decode base64 to object (x402 header format)
 */
export function decodeBase64<T>(base64: string): T {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
}

/** Shared test secret for JWT signing (must match config mock) */
export const TEST_JWT_SECRET = 'test-jwt-secret-for-unit-tests-32ch';

/**
 * Create a mock JWT token (unsigned, for decode-only tests or when jwtSecret is not set)
 */
export function createMockJwt(claims: {
  email?: string;
  wallet?: string;
  sub?: string;
  exp?: number;
} = {}): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    email: claims.email || 'test@example.com',
    wallet: claims.wallet || '0x1234567890123456789012345678901234567890',
    sub: claims.sub || 'user-123',
    iat: Math.floor(Date.now() / 1000),
    exp: claims.exp || Math.floor(Date.now() / 1000) + 3600,
  };

  // Simple mock JWT (not cryptographically valid, but parseable)
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = 'mock-signature';

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Create a properly signed JWT token (for tests where jwtSecret is configured)
 */
export async function createSignedJwt(claims: {
  email?: string;
  wallet?: string;
  sub?: string;
  exp?: number;
} = {}, secret: string = TEST_JWT_SECRET): Promise<string> {
  const { SignJWT } = await import('jose');
  const secretKey = new TextEncoder().encode(secret);

  const builder = new SignJWT({
    email: claims.email || 'test@example.com',
    wallet: claims.wallet || '0x1234567890123456789012345678901234567890',
    sub: claims.sub || 'user-123',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt();

  if (claims.exp) {
    builder.setExpirationTime(claims.exp);
  } else {
    builder.setExpirationTime('1h');
  }

  return builder.sign(secretKey);
}
