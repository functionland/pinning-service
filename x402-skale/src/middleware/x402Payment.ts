/**
 * x402 Payment Middleware - Standards Compliant
 *
 * Implements the x402 protocol as specified by Coinbase/x402.
 *
 * Standard Headers:
 * - X-PAYMENT-REQUIRED: Base64-encoded payment requirements (402 response)
 * - X-PAYMENT: Base64-encoded payment payload (client request)
 * - X-PAYMENT-RESPONSE: Base64-encoded settlement response (success response)
 *
 * Flow:
 * 1. Client requests resource
 * 2. Server returns 402 with X-PAYMENT-REQUIRED header
 * 3. Client signs payment and retries with X-PAYMENT header
 * 4. Server verifies via facilitator /verify
 * 5. Server performs work (proxy to S3)
 * 6. Server settles via facilitator /settle
 * 7. Server returns resource with X-PAYMENT-RESPONSE header
 *
 * IMPORTANT: No JWT required - the payment signature IS the authentication.
 * The payer's wallet address becomes the user identity.
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type {
  Env,
  X402PaymentInfo,
  FacilitatorVerifyResponse,
  FacilitatorSettleResponse,
} from '../types/index.js';
import { config, getNetworkIdentifier, getAssetIdentifier } from '../config/index.js';
import { calculatePriceMicroUsdc, microUsdcToUsdc } from '../utils/pricing.js';
import { HttpError } from './errorHandler.js';
import {
  createPaymentLog,
  markPaymentVerified,
  markPaymentSettled,
  markPaymentFailed,
} from '../database/repositories/paymentLogs.js';

// Constants
const DEFAULT_TTL_SECONDS = 3600;      // 1 hour default
const MAX_TTL_SECONDS = 30 * 24 * 3600; // 30 days max
const MIN_TTL_SECONDS = 60;             // 1 minute min
const PAYMENT_TIMEOUT_SECONDS = 300;    // 5 minutes to complete payment

/**
 * x402 Payment Required Response
 *
 * This is the standard x402 response format sent in the X-PAYMENT-REQUIRED header.
 * Also included in response body for convenience.
 * Supports both v1 (legacy) and v2 (RelAI) formats.
 */
export interface X402PaymentRequired {
  /** x402 protocol version (1 = legacy, 2 = RelAI) */
  x402Version: number;
  /** Accepted payment options */
  accepts: X402PaymentOption[];
  /** Extensions for v2 protocol (empty object for now, Zauth goes here later) */
  extensions?: Record<string, unknown>;
  /** Human-readable error message */
  error?: string;
}

/**
 * Payment option in x402 accepts array
 */
export interface X402PaymentOption {
  /** Payment scheme (e.g., "exact" for exact amount) */
  scheme: 'exact';
  /** Network in CAIP-2 format (e.g., "eip155:324705682") */
  network: string;
  /** Maximum amount required in smallest unit (e.g., microUSDC) */
  maxAmountRequired: string;
  /** Recipient address */
  payTo: string;
  /** Asset in CAIP-19 format or contract address */
  asset: string;
  /** Human-readable description */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
  /** Maximum time for payment to be valid */
  maxTimeoutSeconds?: number;
  /** Resource being purchased */
  resource?: string;
  /** Additional metadata */
  extra?: {
    /** Facilitator URL for verification */
    facilitatorUrl?: string;
    /** Token name */
    name?: string;
    /** Token version for EIP-712 */
    version?: string;
    /** Asset transfer method: eip3009 (TransferWithAuthorization) or permit2 */
    assetTransferMethod?: 'eip3009' | 'permit2';
  };
}

/**
 * Settlement response in X-PAYMENT-RESPONSE header
 */
export interface X402PaymentResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  error?: string;
}

/**
 * Encode object to base64 for headers
 */
function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

/**
 * Decode base64 header to object
 */
function decodeHeader<T>(base64: string): T {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
}

/**
 * Extract payment header from request
 * Supports both X-PAYMENT and Payment-Authorization headers
 */
function getPaymentHeader(c: Context): string | null {
  // Standard x402 header
  const xPayment = c.req.header('X-PAYMENT');
  if (xPayment) return xPayment;

  // Alternative header used by some implementations
  const paymentAuth = c.req.header('Payment-Authorization');
  if (paymentAuth) {
    // Remove "x402 " prefix if present
    return paymentAuth.replace(/^x402\s+/i, '');
  }

  return null;
}

/**
 * Parse TTL from request headers
 */
function parseTtl(c: Context): number {
  const ttlHeader = c.req.header('X-Fula-TTL') || c.req.header('X-TTL-Seconds');
  const ttl = parseInt(ttlHeader || String(DEFAULT_TTL_SECONDS), 10);
  return Math.min(Math.max(ttl, MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

/**
 * Build 402 Payment Required response
 * Supports both v1 (legacy) and v2 (RelAI) formats based on config.x402Version
 */
function buildPaymentRequiredResponse(
  c: Context,
  sizeBytes: number,
  ttlSeconds: number,
  requiredMicroUsdc: number
): Response {
  const sizeMb = sizeBytes / (1024 * 1024);
  const hours = Math.ceil(ttlSeconds / 3600);

  const paymentRequired: X402PaymentRequired = {
    x402Version: config.x402Version,
    accepts: [
      {
        scheme: 'exact',
        network: getNetworkIdentifier(),
        maxAmountRequired: requiredMicroUsdc.toString(),
        payTo: config.receivingAddress,
        asset: getAssetIdentifier(),
        description: `Storage: ${sizeMb.toFixed(2)} MB for ${hours} hour${hours > 1 ? 's' : ''}`,
        mimeType: 'application/octet-stream',
        maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
        resource: c.req.url,
        extra: {
          facilitatorUrl: config.facilitatorUrl,
          name: config.paymentTokenName,
          version: config.paymentTokenVersion,
          assetTransferMethod: config.assetTransferMethod,
        },
      },
    ],
    error: 'Payment Required',
  };

  // Add extensions for v2 (empty for now, Zauth can be added later)
  if (config.x402Version >= 2) {
    paymentRequired.extensions = {};
  }

  // Encode for header
  const headerValue = encodeHeader(paymentRequired);

  return c.json(paymentRequired, 402, {
    'X-PAYMENT-REQUIRED': headerValue,
  });
}

/**
 * Build payment requirements object (used for both verify and settle)
 * Supports both v1 (legacy) and v2 (RelAI) formats
 */
function buildPaymentRequirements(expectedAmount: string, resource: string) {
  return {
    scheme: 'exact' as const,
    network: getNetworkIdentifier(),
    maxAmountRequired: expectedAmount,
    resource,
    description: 'x402-skale storage payment',
    mimeType: 'application/octet-stream',
    payTo: config.receivingAddress,
    maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
    asset: getAssetIdentifier(),
    extra: {
      name: config.paymentTokenName,
      version: config.paymentTokenVersion,
      assetTransferMethod: config.assetTransferMethod,
    },
  };
}

/**
 * Verify payment with facilitator
 * Supports both v1 (Corbits - paymentHeader as base64) and v2 (RelAI - paymentPayload as JSON)
 */
async function verifyWithFacilitator(
  paymentHeader: string,
  expectedAmount: string,
  resource: string
): Promise<FacilitatorVerifyResponse> {
  const paymentRequirements = buildPaymentRequirements(expectedAmount, resource);

  console.log(`[x402] Calling facilitator: ${config.facilitatorUrl}/verify`);

  // Decode payment header to extract payer info (needed when facilitator doesn't return it)
  let decodedPayload: Record<string, any> = {};
  try {
    decodedPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
  } catch {
    throw new Error('Invalid payment header: could not decode base64 JSON');
  }

  let requestBody: Record<string, unknown>;

  if (config.x402Version === 1) {
    // v1 (Corbits): Send paymentHeader as base64 string
    requestBody = {
      x402Version: 1,
      paymentHeader: paymentHeader,
      paymentRequirements,
    };
  } else {
    // v2 (RelAI): Send paymentPayload as JSON object
    requestBody = {
      paymentPayload: decodedPayload,
      paymentRequirements,
    };
  }

  const response = await fetch(`${config.facilitatorUrl}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[x402] Facilitator error: ${response.status} ${errorText}`);
    throw new Error(`Facilitator verify failed: ${response.status} ${errorText}`);
  }

  const result = await response.json() as Record<string, unknown>;

  // Extract payer from the decoded payment header (Corbits v1 doesn't return it)
  const payerFromHeader = decodedPayload?.payload?.authorization?.from as string || '';
  const nonce = decodedPayload?.payload?.authorization?.nonce as string || '';

  // Normalize response to support both standard and legacy formats
  return {
    // Standard uses isValid, legacy uses valid
    valid: (result.isValid ?? result.valid) as boolean,
    // Standard uses invalidReason, legacy uses error
    error: (result.invalidReason ?? result.error) as string | undefined,
    // Fall back to payment header fields when facilitator doesn't return them
    paymentId: (result.paymentId ?? result.id ?? nonce) as string,
    payer: (result.payer ?? result.from ?? payerFromHeader) as string,
    amount: (result.amount ?? expectedAmount) as string,
    asset: (result.asset ?? getAssetIdentifier()) as string,
    network: (result.network ?? getNetworkIdentifier()) as string,
  };
}

/**
 * Settle payment with facilitator
 * Supports both v1 (Corbits - paymentHeader as base64) and v2 (RelAI - paymentPayload as JSON)
 */
async function settleWithFacilitator(
  paymentHeader: string,
  expectedAmount: string,
  resource: string
): Promise<FacilitatorSettleResponse> {
  const paymentRequirements = buildPaymentRequirements(expectedAmount, resource);

  let requestBody: Record<string, unknown>;

  if (config.x402Version === 1) {
    // v1 (Corbits): Send paymentHeader as base64 string
    requestBody = {
      x402Version: 1,
      paymentHeader: paymentHeader,
      paymentRequirements,
    };
  } else {
    // v2 (RelAI): Decode and send paymentPayload as JSON object
    let decodedPaymentPayload: unknown;
    try {
      decodedPaymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    } catch (e) {
      throw new Error('Invalid payment header: could not decode base64 JSON');
    }
    requestBody = {
      paymentPayload: decodedPaymentPayload,
      paymentRequirements,
    };
  }

  const response = await fetch(`${config.facilitatorUrl}/settle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facilitator settle failed: ${response.status} ${errorText}`);
  }

  const result = await response.json() as Record<string, unknown>;

  // Normalize response to support both v1 (txHash) and v2 (transaction) formats
  return {
    success: result.success as boolean,
    // v2 uses transaction, v1 uses txHash
    txHash: (result.txHash ?? result.transaction) as string | undefined,
    network: result.network as string | undefined,
    error: result.error as string | undefined,
  };
}

/**
 * x402 Payment Middleware
 *
 * Standards-compliant implementation of x402 protocol.
 * NO JWT REQUIRED - payment signature is the authentication.
 */
export const x402PaymentMiddleware = createMiddleware<Env>(async (c, next) => {
  // Only apply to PUT and DELETE requests (operations that require payment)
  if (c.req.method !== 'PUT' && c.req.method !== 'DELETE') {
    await next();
    return;
  }

  // Get request parameters
  const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
  const ttlSeconds = parseTtl(c);
  const sizeBytes = contentLength;
  const sizeMb = sizeBytes / (1024 * 1024);

  // Calculate required payment
  const requiredMicroUsdc = calculatePriceMicroUsdc(sizeBytes, ttlSeconds);

  // Check for payment header
  const paymentHeader = getPaymentHeader(c);

  // No payment header - return 402 Payment Required
  if (!paymentHeader) {
    console.log(`[x402] No payment header, returning 402 for ${sizeMb.toFixed(2)} MB`);
    return buildPaymentRequiredResponse(c, sizeBytes, ttlSeconds, requiredMicroUsdc);
  }

  // Payment header present - verify with facilitator
  let paymentInfo: X402PaymentInfo;

  try {
    console.log('[x402] Verifying payment with facilitator...');

    const verification = await verifyWithFacilitator(
      paymentHeader,
      requiredMicroUsdc.toString(),
      c.req.url
    );

    if (!verification.valid) {
      console.error('[x402] Payment verification failed:', verification.error);
      throw new HttpError(402, verification.error || 'Invalid payment', 'PAYMENT_INVALID');
    }

    console.log(`[x402] Payment verified: ${verification.paymentId} from ${verification.payer}`);

    // Build payment info
    paymentInfo = {
      paymentId: verification.paymentId,
      payer: verification.payer.toLowerCase(),
      amount: verification.amount,
      amountUsdc: microUsdcToUsdc(parseInt(verification.amount, 10)),
      asset: verification.asset,
      network: verification.network,
      sizeBytes,
      sizeMb,
      ttlSeconds,
      priceUsdc: microUsdcToUsdc(requiredMicroUsdc),
    };

    // Log payment to database (async)
    const bucket = c.req.param('bucket');
    const key = c.req.param('key');
    await createPaymentLog(paymentInfo, bucket, key);
    await markPaymentVerified(paymentInfo.paymentId);

    // Store payment info in context for downstream handlers
    c.set('x402Payment', paymentInfo);
    c.set('x402PaymentHeader', paymentHeader);
    c.set('x402ExpectedAmount', requiredMicroUsdc.toString());

  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    console.error('[x402] Payment verification error:', error);
    const message = error instanceof Error ? error.message : 'Payment verification failed';
    throw new HttpError(402, message, 'PAYMENT_VERIFICATION_FAILED');
  }

  // Proceed with request
  await next();

  // After handler completes, settle payment if successful (2xx response)
  if (c.res.status >= 200 && c.res.status < 300) {
    try {
      console.log(`[x402] Settling payment ${paymentInfo.paymentId}...`);

      const expectedAmount = c.get('x402ExpectedAmount') || requiredMicroUsdc.toString();
      const settlement = await settleWithFacilitator(paymentHeader, expectedAmount, c.req.url);

      if (settlement.success) {
        console.log(`[x402] Payment settled: ${paymentInfo.paymentId}, tx: ${settlement.txHash}`);
        await markPaymentSettled(paymentInfo.paymentId, settlement.txHash);
        paymentInfo.txHash = settlement.txHash;
        c.set('x402Payment', paymentInfo);

        // Add X-PAYMENT-RESPONSE header to response
        const paymentResponse: X402PaymentResponse = {
          success: true,
          transaction: settlement.txHash,
          network: paymentInfo.network,
        };

        // Clone response and add header
        const originalResponse = c.res;
        const body = await originalResponse.clone().text();
        const headers = new Headers(originalResponse.headers);
        headers.set('X-PAYMENT-RESPONSE', encodeHeader(paymentResponse));

        c.res = new Response(body, {
          status: originalResponse.status,
          headers,
        });
      } else {
        console.error('[x402] Settlement failed:', settlement.error);
        await markPaymentFailed(paymentInfo.paymentId, settlement.error || 'Settlement failed');
      }
    } catch (error) {
      console.error('[x402] Settlement error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      await markPaymentFailed(paymentInfo.paymentId, message);
    }
  } else {
    // Request failed, mark payment as failed
    await markPaymentFailed(paymentInfo.paymentId, `Request failed with status ${c.res.status}`);
  }
});

/**
 * Get payment info from context
 */
export function getPaymentInfo(c: Context<Env>): X402PaymentInfo | undefined {
  return c.get('x402Payment');
}

/**
 * Check if request has payment header
 */
export function hasPaymentHeader(c: Context): boolean {
  return getPaymentHeader(c) !== null;
}

export default x402PaymentMiddleware;
