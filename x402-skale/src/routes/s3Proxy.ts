/**
 * S3 Proxy Routes - x402 Standards Compliant (Option C - Gift Model)
 *
 * Handles S3-compatible operations with x402 payment.
 *
 * AUTH MODEL (Option C):
 * - JWT Authorization header: Identifies the user (email from sub claim)
 * - x402 payment header: Provides payment (any wallet can pay for any user)
 *
 * Identity Model:
 * - JWT email = user identity for storage + credits
 * - Wallet = payment source only (no binding enforced)
 * - Supports "gift" payments (anyone can pay for anyone's storage)
 *
 * Flow:
 * 1. Client sends request with both JWT and X-PAYMENT headers
 * 2. JWT middleware extracts user email (identity)
 * 3. x402 middleware verifies payment, settles with facilitator
 * 4. Credits assigned to JWT email (not wallet)
 * 5. JWT passed through to S3 backend for authorization
 */

import { Hono } from 'hono';
import type { Env, UploadResponse } from '../types/index.js';
import { x402PaymentMiddleware, getPaymentInfo } from '../middleware/x402Payment.js';
import { jwtValidatorMiddleware, getJwtUser } from '../middleware/jwtValidator.js';
import { proxyToS3, buildGatewayUrl } from '../services/s3Proxy.js';
import { adjustPinningCredits } from '../services/pinningIntegration.js';
import { trackEphemeralObject } from '../database/repositories/ephemeralObjects.js';
import { HttpError } from '../middleware/errorHandler.js';
import { config } from '../config/index.js';

export const s3ProxyRoutes = new Hono<Env>();

/**
 * PUT /:bucket/:key
 *
 * Upload an object with x402 payment.
 *
 * Headers:
 * - Authorization: Bearer <JWT> (required - passed through to S3)
 * - X-PAYMENT: Base64-encoded payment payload (standard x402)
 *   OR Payment-Authorization: x402 <payload> (alternative)
 * - X-Fula-TTL: <seconds> (optional, default 3600)
 * - Content-Type: <mime-type>
 * - Content-Length: <bytes>
 */
s3ProxyRoutes.put(
  '/:bucket/:key{.+}',
  jwtValidatorMiddleware,      // First: Validate JWT and extract user email
  x402PaymentMiddleware,       // Second: Verify x402 payment (any wallet)
  // Option C: No wallet assertion - any wallet can pay for any user
  async (c) => {
    const bucket = c.req.param('bucket');
    const key = c.req.param('key');
    const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
    const contentType = c.req.header('Content-Type') || 'application/octet-stream';

    const payment = getPaymentInfo(c);
    const jwtUser = getJwtUser(c);

    if (!payment) {
      throw new HttpError(500, 'Payment info not found after middleware', 'INTERNAL_ERROR');
    }

    // Get the original Authorization header to pass through to S3
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new HttpError(401, 'Authorization header required', 'MISSING_AUTH');
    }

    // Get request body
    const body = await c.req.arrayBuffer();
    const bodyBuffer = Buffer.from(body);

    // Proxy to S3 with the original JWT
    console.log(`[upload] Proxying PUT ${bucket}/${key} (${contentLength} bytes) from wallet ${payment.payer}`);

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
      authHeader  // Pass through the original JWT
    );

    if (!result.success) {
      throw new HttpError(
        result.status || 502,
        result.error || 'S3 upload failed',
        'S3_ERROR'
      );
    }

    // Track ephemeral object for cleanup
    // Use JWT sub (user's email) as the user identity - this is what S3 knows
    const expiresAt = new Date(Date.now() + payment.ttlSeconds * 1000);
    const userId = jwtUser?.sub || jwtUser?.email || payment.payer;

    trackEphemeralObject({
      bucket,
      key,
      wallet: userId,  // This is actually the user_id (email from JWT sub)
      sizeBytes: payment.sizeBytes,
      sizeMb: payment.sizeMb,
      paymentId: payment.paymentId,
      expiresAt,
    });

    // Adjust pinning service credits (use JWT email, not wallet)
    const ttlHours = Math.ceil(payment.ttlSeconds / 3600);
    const userEmail = jwtUser?.sub || jwtUser?.email || '';
    const creditResult = await adjustPinningCredits({
      userEmail,           // JWT email - real user identity
      wallet: payment.payer,  // For logging only
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
 * Only the owner (wallet that uploaded) can delete.
 * Requires JWT for S3 access and x402 payment to prove ownership.
 *
 * Headers:
 * - Authorization: Bearer <JWT> (required - passed through to S3)
 * - X-PAYMENT: Base64-encoded payment payload (standard x402)
 */
s3ProxyRoutes.delete(
  '/:bucket/:key{.+}',
  jwtValidatorMiddleware,      // First: Validate JWT and extract user email
  x402PaymentMiddleware,       // Second: Verify x402 payment (any wallet)
  // Option C: No wallet assertion - any wallet can pay for any user
  async (c) => {
    const bucket = c.req.param('bucket');
    const key = c.req.param('key');

    const payment = getPaymentInfo(c);
    if (!payment) {
      throw new HttpError(402, 'Payment required to delete', 'PAYMENT_REQUIRED');
    }

    // Get the original Authorization header to pass through to S3
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new HttpError(401, 'Authorization header required', 'MISSING_AUTH');
    }

    console.log(`[delete] DELETE ${bucket}/${key} by wallet ${payment.payer}`);

    const result = await proxyToS3(
      { method: 'DELETE', bucket, key },
      authHeader  // Pass through the original JWT
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
