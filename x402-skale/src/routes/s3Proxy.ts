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

import { Hono } from 'hono';
import type { Env, UploadResponse } from '../types/index.js';
import { x402PaymentMiddleware, getPaymentInfo } from '../middleware/x402Payment.js';
import { x402OrJwtMiddleware, getJwtUser, getAuthMode } from '../middleware/jwtValidator.js';
import { proxyToS3, buildGatewayUrl } from '../services/s3Proxy.js';
import { adjustPinningCredits } from '../services/pinningIntegration.js';
import { trackEphemeralObject } from '../database/repositories/ephemeralObjects.js';
import { HttpError } from '../middleware/errorHandler.js';
import { config } from '../config/index.js';
import { ensureWalletUserAndGetApiKey } from '../services/walletUser.js';

export const s3ProxyRoutes = new Hono<Env>();

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
 * Download an object.
 * For public objects, no auth required.
 * For private objects, include Authorization header.
 *
 * Headers:
 * - Authorization: Bearer <JWT> (optional - passed through to S3 if provided)
 *
 * Pass-through to S3 backend which handles access control.
 */
s3ProxyRoutes.get('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');

  console.log(`[download] GET ${bucket}/${key}`);

  // Pass through auth header if provided (for private objects)
  // S3 backend handles access control
  const authHeader = c.req.header('Authorization') || '';
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

  // Stream the response
  const headers = new Headers();
  if (result.headers) {
    for (const [name, value] of Object.entries(result.headers)) {
      if (value) headers.set(name, value);
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
 * Check if an object exists.
 *
 * Headers:
 * - Authorization: Bearer <JWT> (optional - passed through to S3 if provided)
 */
s3ProxyRoutes.on('HEAD', '/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');

  // Pass through auth header if provided
  const authHeader = c.req.header('Authorization') || '';
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
 * Delete an object.
 * Requires x402 payment (and optionally JWT for S3 access).
 *
 * Headers:
 * - Authorization: Bearer <JWT> (optional - if absent, x402 payment alone is used)
 * - X-PAYMENT: Base64-encoded payment payload (standard x402)
 */
s3ProxyRoutes.delete(
  '/:bucket/:key{.+}',
  x402OrJwtMiddleware,         // First: Accept JWT OR x402 payment
  x402PaymentMiddleware,       // Second: Verify x402 payment
  async (c) => {
    const bucket = c.req.param('bucket');
    const key = c.req.param('key');

    const payment = getPaymentInfo(c);
    const jwtUser = getJwtUser(c);
    const authMode = getAuthMode(c);

    if (!payment) {
      throw new HttpError(402, 'Payment required to delete', 'PAYMENT_REQUIRED');
    }

    // Determine auth header based on auth mode
    let authHeader: string;

    if (authMode === 'jwt' && jwtUser) {
      // JWT mode: use original JWT for S3
      authHeader = c.req.header('Authorization')!;
      console.log(`[delete] JWT mode: DELETE ${bucket}/${key} by user=${jwtUser.sub || jwtUser.email}`);
    } else {
      // x402-only mode: get/create user's API key, use it for S3
      const walletUser = await ensureWalletUserAndGetApiKey(payment.payer);
      authHeader = `Bearer ${walletUser.apiKey}`;
      console.log(`[delete] x402-only mode: DELETE ${bucket}/${key} by user=${walletUser.email}`);
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

    return c.json({ success: true, bucket, key }, 200);
  }
);

export default s3ProxyRoutes;
