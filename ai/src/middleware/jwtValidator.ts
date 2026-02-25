/**
 * JWT Validator Middleware
 *
 * Validates JWT tokens and extracts user email for AI service.
 */

import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';
import { config } from '../config/index.js';

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
    userEmail: string;
    userToken: string;
    requestId: string;
    requestStartTime: number;
  };
}

/**
 * JWT Validator Middleware
 *
 * Extracts and optionally validates JWT from Authorization header.
 * Sets userEmail in context for downstream handlers.
 */
export const jwtValidatorMiddleware = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authentication required', code: 'MISSING_AUTH' }, 401);
  }

  const token = authHeader.slice(7);

  try {
    // Decode the JWT to extract claims
    const decoded = jose.decodeJwt(token) as JwtPayload;

    // Extract email from claims
    const email = decoded.email || decoded.sub || '';

    if (!email) {
      return c.json({ error: 'Token missing email/sub claim', code: 'INVALID_TOKEN' }, 401);
    }

    // Check expiration if present
    if (decoded.exp && decoded.exp * 1000 < Date.now()) {
      return c.json({ error: 'Token expired', code: 'TOKEN_EXPIRED' }, 401);
    }

    // If JWT_SECRET is configured, verify the signature
    if (config.jwtSecret) {
      try {
        const secret = new TextEncoder().encode(config.jwtSecret);
        await jose.jwtVerify(token, secret);
      } catch (verifyError) {
        console.error('[jwt] Signature verification failed:', verifyError);
        return c.json({ error: 'Invalid token signature', code: 'INVALID_SIGNATURE' }, 401);
      }
    }

    // Store user email and token in context
    c.set('userEmail', email);
    c.set('userToken', token);
  } catch (error) {
    console.error('[jwt] Token decode error:', error);
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }

  await next();
});

export default jwtValidatorMiddleware;
