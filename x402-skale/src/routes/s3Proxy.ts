/**
 * S3 Proxy Routes - x402 Standards Compliant
 *
 * Handles S3-compatible operations with x402 payment.
 *
 * AUTH MODEL:
 * Supports two authentication modes:
 *
 * 1. JWT + x402 (Gift Model):
 *    - JWT Authorization header: Identifies the user (email from sub claim)
 *    - x402 payment header: Provides payment (any wallet can pay for any user)
 *    - Credits assigned to JWT email
 *    - JWT passed through to S3 backend
 *
 * 2. x402-only (Standard x402):
 *    - No JWT required - payment alone authorizes the request
 *    - User auto-created from wallet address ({wallet}@walletpayment.fx.land)
 *    - User's API key used for S3 backend authentication
 *    - Credits assigned to wallet-based email
 *
 * Flow:
 * 1. Client sends request with X-PAYMENT (and optionally JWT)
 * 2. x402OrJwtMiddleware determines auth mode
 * 3. x402 middleware verifies payment, settles with facilitator
 * 4. For x402-only: auto-create user, get their API key
 * 5. Proxy to S3 with appropriate auth
 * 6. Credits assigned to user email
 */

import { Hono, type Context } from 'hono';
import { verifyTypedData, type Hex } from 'viem';
import type { Env, UploadResponse } from '../types/index.js';
import { x402PaymentMiddleware, getPaymentInfo } from '../middleware/x402Payment.js';
import { x402OrJwtMiddleware, getJwtUser, getAuthMode } from '../middleware/jwtValidator.js';
import { proxyToS3, buildGatewayUrl } from '../services/s3Proxy.js';
import { adjustPinningCredits } from '../services/pinningIntegration.js';
import { trackEphemeralObject } from '../database/repositories/ephemeralObjects.js';
import { usdcToFula } from '../utils/pricing.js';
import { HttpError } from '../middleware/errorHandler.js';
import { config } from '../config/index.js';
import { ensureWalletUserAndGetApiKey } from '../services/walletUser.js';

// Nonce tracking for download signature replay prevention
const usedNonces = new Map<string, number>(); // nonceKey -> expiry timestamp

// Periodically clean expired nonce entries
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, expiry] of usedNonces) {
    if (now > expiry) usedNonces.delete(nonce);
  }
}, 60_000);

// EIP-712 types for TransferWithAuthorization (EIP-3009)
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export const s3ProxyRoutes = new Hono<Env>();

/**
 * Resolve auth header for read-only requests (GET/HEAD).
 * No payment charged — verifies wallet identity via EIP-712 signature.
 *
 * Priority:
 * 1. Authorization header (JWT) — passed through as-is
 * 2. X-PAYMENT header — verify EIP-712 signature, look up wallet's API key
 * 3. No auth — returns empty string (S3 decides access)
 */
async function resolveReadAuth(c: Context<Env>): Promise<string> {
  // 1. JWT takes priority
  const jwt = c.req.header('Authorization');
  if (jwt) return jwt;

  // 2. X-PAYMENT header — verify EIP-712 signature, extract wallet, look up API key
  const paymentHeader = c.req.header('X-PAYMENT');
  if (paymentHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
      const auth = decoded?.payload?.authorization;
      const signature = decoded?.payload?.signature as Hex | undefined;
      const claimedWallet = auth?.from as string | undefined;

      if (!claimedWallet || !signature || !auth) {
        console.warn('[download] X-PAYMENT missing wallet, signature, or authorization');
        return '';
      }

      // Verify the EIP-712 signature matches the claimed wallet
      const domain = {
        name: config.paymentTokenName,
        version: config.paymentTokenVersion,
        chainId: config.networkChainId,
        verifyingContract: config.paymentTokenAddress as Hex,
      };

      const message = {
        from: auth.from as Hex,
        to: auth.to as Hex,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      };

      const valid = await verifyTypedData({
        address: claimedWallet as Hex,
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message,
        signature,
      });

      if (!valid) {
        console.warn(`[download] EIP-712 signature verification failed for ${claimedWallet}`);
        return '';
      }

      // Check time validity
      const now = Math.floor(Date.now() / 1000);
      if (now < Number(message.validAfter) || now > Number(message.validBefore)) {
        console.warn(`[download] X-PAYMENT signature expired for ${claimedWallet}`);
        return '';
      }

      // Check for signature replay
      const nonceKey = `${claimedWallet.toLowerCase()}:${auth.nonce}`;
      if (usedNonces.has(nonceKey)) {
        console.warn(`[download] Replay detected for ${claimedWallet}`);
        return '';
      }
      usedNonces.set(nonceKey, Number(message.validBefore));

      // Signature verified — look up wallet's API key
      const walletUser = await ensureWalletUserAndGetApiKey(claimedWallet);
      console.log(`[download] Verified wallet auth: ${walletUser.email}`);
      return `Bearer ${walletUser.apiKey}`;
    } catch (err) {
      console.warn('[download] Failed to verify X-PAYMENT header:', err instanceof Error ? err.message : err);
    }
  }

  return '';
}

/**
 * PUT /:bucket/:key
 *
 * Upload an object with x402 payment.
 *
 * Headers:
 * - Authorization: Bearer <JWT> (optional - if absent, x402 payment alone is used)
 * - X-PAYMENT: Base64-encoded payment payload (standard x402)
 *   OR Payment-Authorization: x402 <payload> (alternative)
 * - X-Fula-TTL: <seconds> (optional, default 3600)
 * - Content-Type: <mime-type>
 * - Content-Length: <bytes>
 */
s3ProxyRoutes.put(
  '/:bucket/:key{.+}',
  x402OrJwtMiddleware,         // First: Accept JWT OR x402 payment
  x402PaymentMiddleware,       // Second: Verify x402 payment
  async (c) => {
    const bucket = c.req.param('bucket');
    const key = c.req.param('key');
    const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
    const contentType = c.req.header('Content-Type') || 'application/octet-stream';

    const payment = getPaymentInfo(c);
    const jwtUser = getJwtUser(c);
    const authMode = getAuthMode(c);

    if (!payment) {
      throw new HttpError(500, 'Payment info not found after middleware', 'INTERNAL_ERROR');
    }

    // Determine auth header and user email based on auth mode
    let authHeader: string;
    let userEmail: string;

    if (authMode === 'jwt' && jwtUser) {
      // JWT mode: use original JWT for S3
      authHeader = c.req.header('Authorization')!;
      userEmail = jwtUser.sub || jwtUser.email || '';
      console.log(`[upload] JWT mode: user=${userEmail}, wallet=${payment.payer}`);
    } else {
      // x402-only mode: get/create user's API key, use it for S3
      const walletUser = await ensureWalletUserAndGetApiKey(payment.payer);
      authHeader = `Bearer ${walletUser.apiKey}`;  // User's own API key!
      userEmail = walletUser.email;
      console.log(`[upload] x402-only mode: user=${userEmail}, wallet=${payment.payer}`);
    }

    // Get request body
    const body = await c.req.arrayBuffer();
    const bodyBuffer = Buffer.from(body);

    // Proxy to S3 with appropriate auth
    console.log(`[upload] Proxying PUT ${bucket}/${key} (${contentLength} bytes)`);

    const result = await proxyToS3(
      {
        method: 'PUT',
        bucket,
        key,
        body: bodyBuffer,
        headers: {
          'Content-Type': contentType,
          'Content-Length': contentLength.toString(),
          // Pass wallet address and payment info as metadata
          'X-Amz-Meta-Wallet': payment.payer,
          'X-Amz-Meta-Payment-Id': payment.paymentId,
          'X-Amz-Meta-Ttl-Seconds': payment.ttlSeconds.toString(),
        },
      },
      authHeader
    );

    if (!result.success) {
      throw new HttpError(
        result.status || 502,
        result.error || 'S3 upload failed',
        'S3_ERROR'
      );
    }

    // Track ephemeral object for cleanup
    const expiresAt = new Date(Date.now() + payment.ttlSeconds * 1000);

    await trackEphemeralObject({
      bucket,
      key,
      wallet: userEmail,  // User email (from JWT or wallet-based)
      sizeBytes: payment.sizeBytes,
      sizeMb: payment.sizeMb,
      paymentId: payment.paymentId,
      expiresAt,
    });

    // Adjust pinning service credits
    const ttlHours = Math.ceil(payment.ttlSeconds / 3600);
    const creditResult = await adjustPinningCredits({
      userEmail,              // User email for credit tracking
      wallet: payment.payer,  // Wallet for logging
      amountUsdc: payment.priceUsdc,
      paymentId: payment.paymentId,
      sizeMb: payment.sizeMb,
      ttlHours,
    });

    if (!creditResult.success) {
      console.warn(`[upload] Credit adjustment failed: ${creditResult.error}`);
      // Continue anyway - payment was already settled
    }

    // Build response
    const response: UploadResponse = {
      success: true,
      cid: result.cid,
      bucket,
      key,
      size_bytes: payment.sizeBytes,
      expires_at: expiresAt.toISOString(),
      tx_hash: payment.txHash,
      gateway_url: result.cid ? buildGatewayUrl(result.cid) : undefined,
    };

    console.log(`[upload] Success: ${bucket}/${key} -> ${result.cid || 'no-cid'}`);

    return c.json(response, 200);
  }
);

/**
 * GET /:bucket/:key
 *
 * Download an object (free, no payment charged).
 * Requires wallet identity verification via X-PAYMENT header or JWT.
 *
 * Headers:
 * - Authorization: Bearer <JWT> (option 1 - passed through to S3)
 * - X-PAYMENT: Base64-encoded EIP-712 signed payload (option 2 - verified locally, free)
 */
s3ProxyRoutes.get('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');

  console.log(`[download] GET ${bucket}/${key}`);

  // Resolve auth from JWT or X-PAYMENT wallet (free, no payment charged)
  const authHeader = await resolveReadAuth(c);
  const result = await proxyToS3(
    { method: 'GET', bucket, key },
    authHeader
  );

  if (!result.success) {
    return c.json(
      { error: result.error || 'Object not found' },
      (result.status || 404) as 404
    );
  }

  // Stream the response, stripping hop-by-hop and encoding headers.
  // Node.js fetch auto-decompresses gzip, so the body is already plain —
  // passing through content-encoding would cause clients to double-decompress.
  const hopByHopHeaders = new Set([
    'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  ]);
  const headers = new Headers();
  if (result.headers) {
    for (const [name, value] of Object.entries(result.headers)) {
      if (value && !hopByHopHeaders.has(name)) headers.set(name, value);
    }
  }

  return new Response(result.body, {
    status: 200,
    headers,
  });
});

/**
 * HEAD /:bucket/:key
 *
 * Check if an object exists (free, no payment charged).
 * Same auth model as GET — JWT or X-PAYMENT with verified EIP-712 signature.
 */
s3ProxyRoutes.on('HEAD', '/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');

  // Resolve auth from JWT or X-PAYMENT wallet (free, no payment charged)
  const authHeader = await resolveReadAuth(c);
  const result = await proxyToS3(
    { method: 'HEAD', bucket, key },
    authHeader
  );

  if (!result.success) {
    return c.body(null, 404);
  }

  const headers = new Headers();
  if (result.headers) {
    for (const [name, value] of Object.entries(result.headers)) {
      if (value) headers.set(name, value);
    }
  }

  return new Response(null, {
    status: 200,
    headers,
  });
});

/**
 * DELETE /:bucket/:key
 *
 * Delete an object (free, no payment charged).
 * Same auth model as GET — wallet identity verified via EIP-712 signature or JWT.
 *
 * Headers:
 * - Authorization: Bearer <JWT> (option 1 - passed through to S3)
 * - X-PAYMENT: Base64-encoded EIP-712 signed payload (option 2 - verified locally, free)
 */
s3ProxyRoutes.delete('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');

  console.log(`[delete] DELETE ${bucket}/${key}`);

  // Same wallet verification as GET — free, no payment charged
  const authHeader = await resolveReadAuth(c);
  if (!authHeader) {
    throw new HttpError(401, 'Wallet verification required. Send X-PAYMENT header with EIP-712 signature.', 'AUTH_REQUIRED');
  }

  const result = await proxyToS3(
    { method: 'DELETE', bucket, key },
    authHeader
  );

  if (!result.success) {
    return c.json(
      { error: result.error || 'Delete failed' },
      (result.status || 500) as 500
    );
  }

  // Mark object as deleted in ephemeral tracking (best effort)
  try {
    const { markObjectDeletedByKey } = await import('../database/repositories/ephemeralObjects.js');
    await markObjectDeletedByKey(bucket, key);
  } catch { /* best effort */ }

  return c.json({ success: true, bucket, key }, 200);
});

/**
 * POST /credit
 *
 * Add FULA credits to account by paying via x402 (no file upload).
 * User pays any amount >= minimum; FULA credits are calculated and added.
 *
 * Headers:
 * - X-PAYMENT: Base64-encoded x402 payment
 * - Authorization: Bearer <JWT> (optional)
 */
s3ProxyRoutes.post(
  '/credit',
  x402OrJwtMiddleware,
  x402PaymentMiddleware,
  async (c) => {
    const payment = getPaymentInfo(c);
    const jwtUser = getJwtUser(c);
    const authMode = getAuthMode(c);

    if (!payment) {
      throw new HttpError(500, 'Payment info not found', 'INTERNAL_ERROR');
    }

    // Determine user email
    let userEmail: string;
    if (authMode === 'jwt' && jwtUser) {
      userEmail = jwtUser.sub || jwtUser.email || '';
    } else {
      const walletUser = await ensureWalletUserAndGetApiKey(payment.payer);
      userEmail = walletUser.email;
    }

    // Add credits
    const fulaAmount = usdcToFula(payment.priceUsdc);
    const creditResult = await adjustPinningCredits({
      userEmail,
      wallet: payment.payer,
      amountUsdc: payment.priceUsdc,
      paymentId: payment.paymentId,
      sizeMb: 0,
      ttlHours: 0,
    });

    return c.json({
      success: true,
      creditsAdded: fulaAmount,
      newBalance: creditResult.newBalance,
      amountPaidUsdc: payment.priceUsdc,
      tx_hash: payment.txHash,
      userEmail,
    }, 200);
  }
);

export default s3ProxyRoutes;
