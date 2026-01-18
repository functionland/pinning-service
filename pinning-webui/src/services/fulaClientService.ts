/**
 * Fula Client Service
 *
 * Wrapper for @functionland/fula-client WASM library.
 * Handles client initialization and provides decryption functions.
 */

import init, {
  createEncryptedClient,
  getDecrypted,
  getDecryptedByStorageKey,
  getWithToken,
  getWithShare,
  acceptShare,
  isShareValid,
  listBuckets,
  listDecrypted,
  listDirectory,
  exportSecretKey,
  getPublicKey,
  type EncryptedClient,
  type AcceptedShare,
} from '@functionland/fula-client';

// Default gateway endpoint
const FULA_GATEWAY_ENDPOINT = 'https://s3.cloud.fx.land';

// Track WASM initialization
let wasmInitialized = false;

// Cached client instance
let cachedClient: any = null;
let cachedSecretKey: Uint8Array | null = null;
let cachedAccessToken: string | null = null;

/**
 * Initialize WASM module (must be called before using any fula-client functions)
 */
async function ensureWasmInitialized(): Promise<void> {
  if (!wasmInitialized) {
    await init();
    wasmInitialized = true;
  }
}

/**
 * Get or create an encrypted Fula client
 *
 * @param secretKey - 32-byte encryption key (from PBKDF2 derivation)
 * @param accessToken - JWT token for S3 authentication
 * @param endpoint - Gateway endpoint (default: https://s3.cloud.fx.land)
 * @returns Encrypted client handle
 */
export async function getFulaClient(
  secretKey: Uint8Array,
  accessToken: string,
  endpoint: string = FULA_GATEWAY_ENDPOINT
): Promise<any> {
  await ensureWasmInitialized();

  // Check if we can reuse cached client (same key and token)
  if (
    cachedClient &&
    cachedSecretKey &&
    cachedAccessToken === accessToken &&
    arraysEqual(secretKey, cachedSecretKey)
  ) {
    return cachedClient;
  }

  // Create new encrypted client
  const client = await createEncryptedClient(
    { endpoint, accessToken },
    { secretKey, obfuscationMode: 'flatNamespace' }
  );

  // Cache for reuse
  cachedClient = client;
  cachedSecretKey = new Uint8Array(secretKey);
  cachedAccessToken = accessToken;

  // Debug: Log the public key derived from the secret key
  // This helps verify the key derivation matches FxFiles mobile
  try {
    const publicKey = await getPublicKey(client);
    console.log('[getFulaClient] Public key (first 8 bytes):',
      Array.from(new Uint8Array(publicKey).slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    console.log('[getFulaClient] Full public key (base64):',
      btoa(String.fromCharCode(...new Uint8Array(publicKey))));
  } catch (e) {
    console.warn('[getFulaClient] Could not get public key:', e);
  }

  return client;
}

/**
 * Fetch and decrypt a file using the Fula client
 *
 * @param client - Fula encrypted client handle
 * @param bucket - Bucket name
 * @param path - Original file path
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
 * List all buckets
 *
 * @param client - Fula encrypted client handle
 * @returns Array of bucket info
 */
export async function listFulaBuckets(client: any): Promise<any[]> {
  return listBuckets(client);
}

/**
 * List files in a bucket with decrypted metadata
 *
 * @param client - Fula encrypted client handle
 * @param bucket - Bucket name
 * @param options - List options (prefix, etc.)
 * @returns Array of file info
 */
export async function listDecryptedFiles(
  client: any,
  bucket: string,
  options?: { prefix?: string }
): Promise<any[]> {
  return listDecrypted(client, bucket, options || {});
}

/**
 * List directory structure
 *
 * @param client - Fula encrypted client handle
 * @param bucket - Bucket name
 * @param prefix - Directory prefix
 * @returns Directory listing
 */
export async function listFulaDirectory(
  client: any,
  bucket: string,
  prefix: string
): Promise<any> {
  return listDirectory(client, bucket, prefix);
}

/**
 * Fetch and decrypt a file by its storage key from a specific bucket
 *
 * Use this when you know both the bucket and the storage key (CID).
 *
 * @param client - Fula encrypted client handle
 * @param bucket - Bucket name
 * @param storageKey - Storage key (CID) of the encrypted file
 * @returns Decrypted data as Uint8Array
 */
export async function fetchAndDecryptByStorageKey(
  client: any,
  bucket: string,
  storageKey: string
): Promise<Uint8Array> {
  const decrypted = await getDecryptedByStorageKey(client, bucket, storageKey);
  return new Uint8Array(decrypted);
}

/**
 * Fetch and decrypt a file by its storage key (CID), searching across buckets
 *
 * Since we don't know which bucket contains the CID, we try common buckets first
 * then fall back to listing all buckets and trying each one.
 *
 * @param client - Fula encrypted client handle
 * @param cid - Storage key (CID) of the encrypted file
 * @returns Object containing decrypted data and the bucket where it was found
 */
export async function fetchAndDecryptByCid(
  client: any,
  cid: string
): Promise<{ data: Uint8Array; bucket: string }> {
  // Common file buckets to try first (optimization)
  const priorityBuckets = ['photos', 'videos', 'documents', 'audio', 'files'];

  // Try priority buckets first
  for (const bucketName of priorityBuckets) {
    try {
      console.log(`[fetchAndDecryptByCid] Trying bucket: ${bucketName}`);
      const data = await getDecryptedByStorageKey(client, bucketName, cid);
      console.log(`[fetchAndDecryptByCid] Found in bucket: ${bucketName}`);
      return { data: new Uint8Array(data), bucket: bucketName };
    } catch (e) {
      // Not in this bucket, try next
      continue;
    }
  }

  // If not found in priority buckets, list all buckets and try each
  console.log('[fetchAndDecryptByCid] Not in priority buckets, listing all buckets...');
  const allBuckets = await listBuckets(client);
  const otherBuckets = allBuckets
    .map((b: any) => b.name)
    .filter((name: string) => !priorityBuckets.includes(name));

  for (const bucketName of otherBuckets) {
    try {
      console.log(`[fetchAndDecryptByCid] Trying bucket: ${bucketName}`);
      const data = await getDecryptedByStorageKey(client, bucketName, cid);
      console.log(`[fetchAndDecryptByCid] Found in bucket: ${bucketName}`);
      return { data: new Uint8Array(data), bucket: bucketName };
    } catch (e) {
      // Not in this bucket, try next
      continue;
    }
  }

  throw new Error('File not found in any bucket. It may have been deleted from cloud storage.');
}

/**
 * Clear cached client (call on logout)
 */
export function clearFulaClient(): void {
  cachedClient = null;
  cachedSecretKey = null;
  cachedAccessToken = null;
}

// ============================================================================
// Share Token Functions (for v2 share links)
// ============================================================================

/**
 * Create a Fula client for share link decryption (no access token needed)
 *
 * For public share links, the secretKey is the link's private key (sk from URL)
 *
 * @param secretKey - 32-byte link private key
 * @param endpoint - Gateway endpoint (default: https://ipfs.cloud.fx.land)
 * @returns Encrypted client handle
 */
export async function createShareClient(
  secretKey: Uint8Array,
  endpoint: string = 'https://ipfs.cloud.fx.land'
): Promise<EncryptedClient> {
  await ensureWasmInitialized();

  console.log('[createShareClient] Creating client with:', {
    endpoint,
    secretKeyLength: secretKey.length,
    secretKeyFirst4: Array.from(secretKey.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' '),
  });

  // Create client with link's private key
  // Use flatNamespace mode to match FxFiles encryption format
  const client = await createEncryptedClient(
    { endpoint },
    { secretKey, obfuscationMode: 'flatNamespace' }
  );

  return client;
}

/**
 * Decrypt shared content using a share token
 *
 * @param client - Fula encrypted client (created with link's private key)
 * @param bucket - Bucket name
 * @param storageKey - Storage key (CID) of the encrypted file
 * @param tokenJson - ShareToken JSON string from fula_client
 * @returns Decrypted data as Uint8Array
 */
export async function decryptWithShareToken(
  client: EncryptedClient,
  bucket: string,
  storageKey: string,
  tokenJson: string
): Promise<Uint8Array> {
  const decrypted = await getWithToken(client, bucket, storageKey, tokenJson);
  return new Uint8Array(decrypted);
}

/**
 * Accept a share token and get an AcceptedShare handle
 *
 * @param client - Fula encrypted client
 * @param tokenJson - ShareToken JSON string
 * @returns AcceptedShare handle for use with getWithShare
 */
export async function acceptShareToken(
  client: EncryptedClient,
  tokenJson: string
): Promise<AcceptedShare> {
  return acceptShare(client, tokenJson);
}

/**
 * Check if an accepted share is still valid (not expired)
 *
 * @param share - AcceptedShare handle
 * @returns true if share is valid, false if expired
 */
export function isShareTokenValid(share: AcceptedShare): boolean {
  return isShareValid(share);
}

/**
 * Decrypt shared content using an AcceptedShare handle (two-step approach)
 *
 * @param client - Fula encrypted client
 * @param bucket - Bucket name
 * @param storageKey - Storage key (CID) of the encrypted file
 * @param share - AcceptedShare handle from acceptShareToken
 * @returns Decrypted data as Uint8Array
 */
export async function decryptWithAcceptedShare(
  client: EncryptedClient,
  bucket: string,
  storageKey: string,
  share: AcceptedShare
): Promise<Uint8Array> {
  const decrypted = await getWithShare(client, bucket, storageKey, share);
  return new Uint8Array(decrypted);
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
