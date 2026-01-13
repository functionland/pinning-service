/**
 * Fula Client Service
 *
 * Wrapper for @functionland/fula-client WASM library.
 * Handles client initialization and provides decryption functions.
 */

import { createEncryptedClient, getDecrypted } from '@functionland/fula-client';

// Default gateway endpoint
const FULA_GATEWAY_ENDPOINT = 'https://ipfs.cloud.fx.land:9000';

// Cached client instance
let cachedClient: any = null;
let cachedSecretKey: Uint8Array | null = null;

/**
 * Get or create an encrypted Fula client
 *
 * @param secretKey - 32-byte encryption key (from PBKDF2 derivation)
 * @param accessToken - JWT token for S3 authentication
 * @param endpoint - Gateway endpoint (default: https://ipfs.cloud.fx.land:9000)
 * @returns Encrypted client handle
 */
export async function getFulaClient(
  secretKey: Uint8Array,
  accessToken: string,
  endpoint: string = FULA_GATEWAY_ENDPOINT
): Promise<any> {
  // Check if we can reuse cached client (same key)
  if (cachedClient && cachedSecretKey && arraysEqual(secretKey, cachedSecretKey)) {
    return cachedClient;
  }

  // Create new encrypted client
  const client = await createEncryptedClient({
    endpoint,
    accessToken,
  }, {
    secretKey,
    enableMetadataPrivacy: true,
    obfuscationMode: 'flatNamespace',
  });

  // Cache for reuse
  cachedClient = client;
  cachedSecretKey = new Uint8Array(secretKey);

  return client;
}

/**
 * Fetch and decrypt a file using the Fula client
 *
 * @param client - Fula encrypted client handle
 * @param bucket - Bucket name
 * @param path - Original file path (not CID)
 * @returns Decrypted data as Uint8Array
 */
export async function fetchAndDecryptFula(
  client: any,
  bucket: string,
  path: string
): Promise<Uint8Array> {
  const decrypted = await getDecrypted(client, bucket, path);
  return new Uint8Array(decrypted);
}

/**
 * Clear cached client (call on logout)
 */
export function clearFulaClient(): void {
  cachedClient = null;
  cachedSecretKey = null;
}

/**
 * Helper to compare two Uint8Arrays
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
