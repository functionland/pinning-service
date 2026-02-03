/**
 * Type Definitions for x402-skale Gateway
 */

import type { Context } from 'hono';

// ============================================
// Environment / Context Types
// ============================================

export interface Env {
  Variables: {
    // x402 payment info (set by x402 middleware after verification)
    x402Payment?: X402PaymentInfo;

    // x402 payment header (raw header for settlement)
    x402PaymentHeader?: string;

    // x402 expected amount (for settlement)
    x402ExpectedAmount?: string;

    // JWT user info (set by JWT validator)
    jwtUser?: JwtUserInfo;

    // Auth mode (which authentication method was used)
    authMode?: 'jwt' | 'x402';

    // Request metadata
    requestId: string;
    requestStartTime: number;
  };
}

// ============================================
// x402 Payment Types
// ============================================

export interface X402PaymentInfo {
  paymentId: string;
  payer: string;           // Wallet address from x402 signature
  amount: string;          // Raw amount (microUSDC)
  amountUsdc: number;      // Human-readable USDC
  asset: string;           // Token address
  network: string;         // Chain identifier
  txHash?: string;         // Transaction hash after settlement
  sizeMb: number;          // Calculated from Content-Length
  sizeBytes: number;
  ttlSeconds: number;      // From X-Fula-TTL header
  priceUsdc: number;       // Calculated price
}

export interface X402PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: {
    facilitatorUrl?: string;
    name?: string;
    version?: string;
  };
}

export interface X402PaymentRequiredResponse {
  error: string;
  code: string;
  accepts: X402PaymentRequirements[];
}

// ============================================
// Facilitator Types
// ============================================

export interface FacilitatorVerifyRequest {
  payment: string;           // Payment-Authorization header value
  expectedAmount?: string;
  expectedRecipient?: string;
  expectedNetwork?: string;
  expectedAsset?: string;
}

export interface FacilitatorVerifyResponse {
  valid: boolean;
  paymentId: string;
  payer: string;
  amount: string;
  asset: string;
  network: string;
  error?: string;
}

export interface FacilitatorSettleRequest {
  paymentId: string;
}

export interface FacilitatorSettleResponse {
  success: boolean;
  txHash?: string;       // Legacy format
  transaction?: string;  // Standard x402 format
  network?: string;
  error?: string;
}

// ============================================
// JWT Types
// ============================================

export interface JwtUserInfo {
  email: string;
  wallet?: string;         // Wallet address from JWT claims
  sub?: string;            // Subject (user ID)
  iat?: number;            // Issued at
  exp?: number;            // Expiration
}

export interface JwtPayload {
  email?: string;
  wallet?: string;
  sub?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

// ============================================
// Database Types
// ============================================

export interface PaymentLog {
  id: number;
  payment_id: string;
  wallet: string;
  tx_hash: string | null;
  amount_raw: string;
  amount_usdc: number;
  network: string;
  bucket: string | null;
  object_key: string | null;
  size_bytes: number | null;
  size_mb: number | null;
  ttl_seconds: number | null;
  status: 'pending' | 'verified' | 'settled' | 'failed';
  verified_at: string | null;
  settled_at: string | null;
  error_message: string | null;
  created_at: string;
}

export interface EphemeralObject {
  id: number;
  bucket: string;
  object_key: string;
  wallet: string;
  size_bytes: number;
  size_mb: number;
  payment_id: string | null;
  expires_at: string;
  deleted: number;
  deleted_at: string | null;
  delete_error: string | null;
  created_at: string;
}

// ============================================
// S3 Proxy Types
// ============================================

export interface S3ProxyRequest {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  bucket: string;
  key: string;
  body?: ReadableStream<Uint8Array> | Buffer | null;
  headers?: Record<string, string>;
}

export interface S3ProxyResponse {
  success: boolean;
  status?: number;
  body?: ReadableStream<Uint8Array> | Buffer;
  headers?: Record<string, string>;
  error?: string;
  cid?: string;            // IPFS CID from response
}

// ============================================
// Pinning Service Types
// ============================================

export interface CreditAdjustmentRequest {
  email: string;
  amount: number;
  reason: string;
}

export interface CreditAdjustmentResponse {
  success: boolean;
  newBalance?: number;
  isSuspended?: boolean;
  error?: string;
}

// ============================================
// API Response Types
// ============================================

export interface HealthResponse {
  status: 'ok' | 'error';
  version: string;
  uptime: number;
  database: 'connected' | 'disconnected';
  timestamp: string;
}

export interface UploadResponse {
  success: boolean;
  cid?: string;
  bucket: string;
  key: string;
  size_bytes: number;
  expires_at: string;
  tx_hash?: string;
  gateway_url?: string;
  error?: string;
}

export interface ErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
}
