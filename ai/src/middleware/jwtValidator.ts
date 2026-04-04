/**
 * JWT Validator Middleware
 *
 * Validates JWT tokens and extracts user identity for AI service.
 * Hashes email to userId (SHA-256) — no plain-text email stored.
 */

import crypto from 'crypto';
import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';
import { config } from '../config/index.js';

function emailToUserId(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
}

interface JwtPayload {
  email?: string;
  sub?: string;
  wallet?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

interface Env {
  Variables: {
    userId: string;
    userToken: string;
    requestId: string;
    requestStartTime: number;
  };
}

/**
 * JWT Validator Middleware
 *
 * Extracts and optionally validates JWT from Authorization header.
 * Sets userId (hashed) in context for downstream handlers.
 */
export const jwtValidatorMiddleware = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authentication required', code: 'MISSING_AUTH' }, 401);
  }

  // Reject if JWT_SECRET is not configured — AI service always requires verified JWT
  if (!config.jwtSecret) {
    return c.json({ error: 'JWT authentication not configured', code: 'JWT_NOT_CONFIGURED' }, 500);
  }

  const token = authHeader.slice(7);

  try {
    // Verify JWT signature
    const secret = new TextEncoder().encode(config.jwtSecret);
    await jose.jwtVerify(token, secret);

    // Decode the JWT to extract claims
    const decoded = jose.decodeJwt(token) as JwtPayload;

    // Extract email from claims and hash to userId
    const email = decoded.email || decoded.sub || '';

    if (!email) {
      return c.json({ error: 'Token missing email/sub claim', code: 'INVALID_TOKEN' }, 401);
    }

    // Check expiration if present
    if (decoded.exp && decoded.exp * 1000 < Date.now()) {
      return c.json({ error: 'Token expired', code: 'TOKEN_EXPIRED' }, 401);
    }

    // Hash email to userId — no plain-text email stored or passed downstream
    const userId = email.includes('@') ? emailToUserId(email) : email;

    // Store userId and token in context
    c.set('userId', userId);
    c.set('userToken', token);
  } catch (error) {
    console.error('[jwt] Token decode/verify error:', error);
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }

  await next();
});

export default jwtValidatorMiddleware;
