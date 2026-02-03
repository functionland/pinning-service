/**
 * JWT Validator Middleware
 *
 * Validates JWT tokens and extracts user/wallet information.
 * The JWT is passed through to the S3 backend for actual authentication.
 */

import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';
import type { Env, JwtUserInfo, JwtPayload } from '../types/index.js';
import { config } from '../config/index.js';
import { HttpError } from './errorHandler.js';

/**
 * JWT Validator Middleware
 *
 * Extracts and optionally validates JWT from Authorization header.
 * Stores user info in context for downstream handlers.
 */
export const jwtValidatorMiddleware = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or invalid Authorization header', 'MISSING_AUTH');
  }

  const token = authHeader.slice(7); // Remove 'Bearer '

  try {
    // Decode the JWT to extract claims
    // Note: We decode but don't verify here because the S3 backend will verify
    // If JWT_SECRET is set, we can also verify locally
    const decoded = jose.decodeJwt(token) as JwtPayload;

    // Extract user info
    const userInfo: JwtUserInfo = {
      email: decoded.email || decoded.sub || '',
      wallet: decoded.wallet?.toLowerCase(),
      sub: decoded.sub,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    // Check expiration if present
    if (decoded.exp && decoded.exp * 1000 < Date.now()) {
      throw new HttpError(401, 'Token expired', 'TOKEN_EXPIRED');
    }

    // If JWT_SECRET is configured, verify the signature
    if (config.jwtSecret) {
      try {
        const secret = new TextEncoder().encode(config.jwtSecret);
        await jose.jwtVerify(token, secret);
      } catch (verifyError) {
        console.error('[jwt] Signature verification failed:', verifyError);
        throw new HttpError(401, 'Invalid token signature', 'INVALID_SIGNATURE');
      }
    }

    // Store user info in context
    c.set('jwtUser', userInfo);

    console.log(`[jwt] User authenticated: ${userInfo.email || userInfo.sub}`);

  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    console.error('[jwt] Token decode error:', error);
    throw new HttpError(401, 'Invalid token', 'INVALID_TOKEN');
  }

  await next();
});

/**
 * Middleware that accepts JWT OR x402 payment (for x402 standard compliance)
 * - If JWT present: validate and use it (existing behavior)
 * - If no JWT: allow through in x402 mode (x402PaymentMiddleware will handle 402 response)
 *
 * Note: We don't check for X-PAYMENT header here because the x402 flow is:
 * 1. Client sends request with no payment → gets 402 with requirements
 * 2. Client signs payment and retries with X-PAYMENT → succeeds
 * The x402PaymentMiddleware handles the 402 response for step 1.
 */
export const x402OrJwtMiddleware = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    // JWT mode: validate JWT (same logic as jwtValidatorMiddleware)
    const token = authHeader.slice(7);

    try {
      const decoded = jose.decodeJwt(token) as JwtPayload;

      const userInfo: JwtUserInfo = {
        email: decoded.email || decoded.sub || '',
        wallet: decoded.wallet?.toLowerCase(),
        sub: decoded.sub,
        iat: decoded.iat,
        exp: decoded.exp,
      };

      // Check expiration if present
      if (decoded.exp && decoded.exp * 1000 < Date.now()) {
        throw new HttpError(401, 'Token expired', 'TOKEN_EXPIRED');
      }

      // If JWT_SECRET is configured, verify the signature
      if (config.jwtSecret) {
        try {
          const secret = new TextEncoder().encode(config.jwtSecret);
          await jose.jwtVerify(token, secret);
        } catch (verifyError) {
          console.error('[jwt] Signature verification failed:', verifyError);
          throw new HttpError(401, 'Invalid token signature', 'INVALID_SIGNATURE');
        }
      }

      // Store user info and auth mode in context
      c.set('jwtUser', userInfo);
      c.set('authMode', 'jwt');

      console.log(`[auth] JWT mode: ${userInfo.email || userInfo.sub}`);

    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      console.error('[jwt] Token decode error:', error);
      throw new HttpError(401, 'Invalid token', 'INVALID_TOKEN');
    }
  } else {
    // x402-only mode: let x402PaymentMiddleware handle authentication
    // It will return 402 if no payment, or validate payment if present
    c.set('authMode', 'x402');
    console.log('[auth] x402 mode (no JWT, payment handled by x402PaymentMiddleware)');
  }

  await next();
});

/**
 * Get auth mode from context
 */
export function getAuthMode(c: { get: (key: 'authMode') => 'jwt' | 'x402' | undefined }): 'jwt' | 'x402' | undefined {
  return c.get('authMode');
}

/**
 * Verify that the JWT wallet matches the x402 payer wallet
 */
export const walletAssertionMiddleware = createMiddleware<Env>(async (c, next) => {
  const jwtUser = c.get('jwtUser');
  const x402Payment = c.get('x402Payment');

  // Only check if both are present
  if (jwtUser?.wallet && x402Payment?.payer) {
    const jwtWallet = jwtUser.wallet.toLowerCase();
    const x402Wallet = x402Payment.payer.toLowerCase();

    if (jwtWallet !== x402Wallet) {
      console.warn(`[wallet] Mismatch: JWT=${jwtWallet}, x402=${x402Wallet}`);
      throw new HttpError(403, 'Wallet mismatch: JWT wallet does not match payment wallet', 'WALLET_MISMATCH');
    }

    console.log(`[wallet] Wallet verified: ${jwtWallet}`);
  }

  await next();
});

/**
 * Get JWT user info from context
 */
export function getJwtUser(c: { get: (key: 'jwtUser') => JwtUserInfo | undefined }): JwtUserInfo | undefined {
  return c.get('jwtUser');
}

/**
 * Optional JWT validation (doesn't fail if no token present)
 */
export const optionalJwtMiddleware = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const decoded = jose.decodeJwt(token) as JwtPayload;

      const userInfo: JwtUserInfo = {
        email: decoded.email || decoded.sub || '',
        wallet: decoded.wallet?.toLowerCase(),
        sub: decoded.sub,
        iat: decoded.iat,
        exp: decoded.exp,
      };

      c.set('jwtUser', userInfo);
    } catch {
      // Ignore errors for optional validation
    }
  }

  await next();
});

export default jwtValidatorMiddleware;
