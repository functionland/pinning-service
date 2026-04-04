/**
 * Wallet User Service
 *
 * Manages auto-creation of users for x402 wallet payments.
 * Users are identified by userId (SHA-256 hash of synthetic wallet email).
 * API keys are auto-generated for each user.
 */

import { createHash } from 'crypto';
import { config } from '../config/index.js';
import { normalizeAddress } from '../utils/address.js';

// In-memory cache for API keys (TTL: 1 hour)
const apiKeyCache = new Map<string, { apiKey: string; createdAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-flight request deduplication to prevent race conditions
const inFlight = new Map<string, Promise<{ userId: string; apiKey: string }>>();

/**
 * Generate synthetic email for a wallet address (used only for userId derivation)
 */
function walletToEmail(wallet: string): string {
  return `${normalizeAddress(wallet)}@walletpayment.fx.land`;
}

/**
 * Derive userId hash from wallet address (same as emailToUserId in webui)
 */
export function walletToUserId(wallet: string): string {
  const email = walletToEmail(wallet);
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}

/**
 * Internal: actually call pinning-webui to ensure user + get API key
 */
async function doEnsureWalletUser(normalizedWallet: string): Promise<{ userId: string; apiKey: string }> {
  const userId = walletToUserId(normalizedWallet);

  console.log(`[wallet-user] Ensuring user + API key: ${userId.slice(0, 8)}...`);

  const response = await fetch(`${config.pinningWebuiUrl}/api/admin/ensure-user-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-System-Key': config.pinningSystemKey,
    },
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed: ${response.status} ${errorText}`);
  }

  const result = await response.json() as { success: boolean; userId: string; apiKey: string };
  const apiKey = result.apiKey;

  // Cache the result
  apiKeyCache.set(normalizedWallet, { apiKey, createdAt: Date.now() });
  console.log(`[wallet-user] User + API key ready: ${userId.slice(0, 8)}...`);

  return { userId, apiKey };
}

/**
 * Ensure user exists and get their API key
 * Creates user + API key in pinning-webui if not exists
 * Returns the API key for S3 authentication
 *
 * Deduplicates concurrent requests for the same wallet.
 */
export async function ensureWalletUserAndGetApiKey(wallet: string): Promise<{ userId: string; apiKey: string }> {
  const normalizedWallet = normalizeAddress(wallet);
  const userId = walletToUserId(normalizedWallet);

  // Check cache first
  const cached = apiKeyCache.get(normalizedWallet);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    console.log(`[wallet-user] Cache hit for ${userId.slice(0, 8)}...`);
    return { userId, apiKey: cached.apiKey };
  }

  // Deduplicate in-flight requests for the same wallet
  const existing = inFlight.get(normalizedWallet);
  if (existing) {
    console.log(`[wallet-user] Deduplicating in-flight request for ${userId.slice(0, 8)}...`);
    return existing;
  }

  const promise = doEnsureWalletUser(normalizedWallet);
  inFlight.set(normalizedWallet, promise);
  try {
    return await promise;
  } catch (error) {
    console.error('[wallet-user] Error ensuring user/key:', error);
    throw error;
  } finally {
    inFlight.delete(normalizedWallet);
  }
}

/**
 * Clear cache (for testing)
 */
export function clearApiKeyCache(): void {
  apiKeyCache.clear();
}
