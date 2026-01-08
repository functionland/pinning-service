/**
 * Error Handler Middleware
 *
 * Global error handling for the gateway.
 */

import type { Context } from 'hono';
import type { Env } from '../types/index.js';

/**
 * HTTP Exception class for structured errors
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Global error handler
 */
export function errorHandler(error: Error, c: Context<Env>): Response {
  console.error('[error]', error);

  // Handle HttpError
  if (error instanceof HttpError) {
    return c.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
      },
      error.status as any
    );
  }

  // Handle validation errors (Zod)
  if (error.name === 'ZodError') {
    return c.json(
      {
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: (error as any).errors,
      },
      400
    );
  }

  // Handle JSON parsing errors
  if (error instanceof SyntaxError && 'body' in error) {
    return c.json(
      {
        error: 'Invalid JSON',
        code: 'INVALID_JSON',
      },
      400
    );
  }

  // Default internal server error
  return c.json(
    {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    },
    500
  );
}

/**
 * Create a 402 Payment Required error
 */
export function paymentRequiredError(message = 'Payment Required'): HttpError {
  return new HttpError(402, message, 'PAYMENT_REQUIRED');
}

/**
 * Create a 401 Unauthorized error
 */
export function unauthorizedError(message = 'Unauthorized'): HttpError {
  return new HttpError(401, message, 'UNAUTHORIZED');
}

/**
 * Create a 403 Forbidden error
 */
export function forbiddenError(message = 'Forbidden'): HttpError {
  return new HttpError(403, message, 'FORBIDDEN');
}

/**
 * Create a 400 Bad Request error
 */
export function badRequestError(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, 'BAD_REQUEST', details);
}

/**
 * Create a 404 Not Found error
 */
export function notFoundError(message = 'Not Found'): HttpError {
  return new HttpError(404, message, 'NOT_FOUND');
}

/**
 * Create a 413 Payload Too Large error
 */
export function payloadTooLargeError(message = 'Payload too large'): HttpError {
  return new HttpError(413, message, 'PAYLOAD_TOO_LARGE');
}

/**
 * Create a 502 Bad Gateway error
 */
export function badGatewayError(message = 'Bad Gateway'): HttpError {
  return new HttpError(502, message, 'BAD_GATEWAY');
}
