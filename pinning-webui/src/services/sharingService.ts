/**
 * Sharing Service for handling encrypted share links
 *
 * Supports three share types:
 * 1. Recipient-specific: Uses recipient's private key (requires user login)
 * 2. Public link: Disposable keypair with secret key in URL fragment
 * 3. Password-protected: Payload encrypted with password-derived key
 *
 * URL format: https://gateway/view/{shareId}#{base64url-payload}
 */

import { decrypt, importKey, getExtensionFromMimeType, deriveSharedSecret, deriveWrapKey } from './encryptionService';
import { createShareClient, decryptWithShareToken, acceptShareToken, decryptWithAcceptedShare } from './fulaClientService';

// Constants
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH_BITS = 256;

/**
 * Share payload structure (in URL fragment)
 *
 * V1 FxFiles format (deprecated):
 * - v: 1
 * - t: token object with share metadata (parsed object)
 * - sk: secret key (base64) - link private key for decryption
 * - b: bucket name
 * - k: file key/path
 * - l: label/name
 *
 * V2 FxFiles format (fula_client):
 * - v: 2
 * - t: ShareToken JSON string from fula_client.createShareTokenWithMode()
 * - sk: secret key (base64) - link private key for decryption
 * - b: bucket name
 * - k: file key/path
 * - l: label/name
 * - f: filename (optional)
 *
 * Password-protected format (both v1 and v2):
 * - v: version number
 * - p: true (password protected flag)
 * - s: base64 salt (16 bytes)
 * - e: base64 encrypted inner payload (contains the public link format)
 * - b: bucket name (in outer payload for display)
 * - k: file key (in outer payload for display)
 */
export interface SharePayload {
  v: number;           // Version (1 = legacy, 2 = fula_client)
  t?: ShareTokenData | string;  // Token: object for v1, JSON string for v2
  sk?: string;         // Secret key (base64) - link private key
  b?: string;          // Bucket name
  k?: string;          // File key/path (v2: for DEK derivation only, NOT for fetching)
  cid?: string;        // Storage key/CID (v2 only: for fetching from IPFS)
  l?: string;          // Label/name
  f?: string;          // Filename (v2 only)
  // Folder share fields
  folder?: boolean;    // true if this is a folder share
  files?: Array<{ n: string; c: string; s: number; t?: string }>; // File manifest: name, CID, size, per-file token
  // Password-protected fields
  p?: boolean;         // Password protected flag
  s?: string;          // Base64 salt (16 bytes)
  e?: string;          // Base64 encrypted inner payload
}

/**
 * Check if payload is v2 format (fula_client)
 */
export function isV2Payload(payload: SharePayload): boolean {
  return payload.v === 2 && typeof payload.t === 'string';
}

/**
 * Check if a payload is password-protected
 */
export function isPasswordProtectedPayload(payload: SharePayload): boolean {
  return payload.p === true && !!payload.s && !!payload.e;
}

/**
 * Snapshot binding - ties a share to a specific content version
 */
export interface SnapshotBinding {
  contentHash: string;
  size: number;
  modifiedAt: number;
  storageKey?: string;  // IPFS CID or object key
}

/**
 * Token data embedded in payload
 */
export interface ShareTokenData {
  id: string;
  ownerPublicKey?: string;
  recipientPublicKey?: string;
  ephemeralPublicKey: string;   // Base64 - REQUIRED for ECDH key unwrapping
  wrappedDek: string;           // Base64 encrypted DEK
  pathScope?: string;
  bucket?: string;
  permissions?: 'readOnly' | 'readWrite' | 'full';
  createdAt?: string;
  expiresAt?: string;
  shareType?: 'recipient' | 'publicLink' | 'passwordLink';
  shareMode?: 'temporal' | 'snapshot';
  snapshotBinding?: SnapshotBinding;  // Contains CID for snapshot mode
  fileName?: string;
  contentType?: string;
}

/**
 * Processed share data for content fetching (v1 format)
 */
export interface ProcessedShareData {
  shareId: string;     // Share ID for content fetching
  cid?: string;        // IPFS CID (from snapshotBinding.storageKey)
  bucket: string;
  path: string;
  name: string;
  dek: CryptoKey;      // Decrypted data encryption key
  expiresAt?: string;
  contentType?: string;
}

/**
 * Processed share data for v2 format (fula_client)
 */
export interface FolderFileEntry {
  name: string;        // Relative file name within the folder
  cid: string;         // Storage key / CID
  size: number;        // File size in bytes
  tokenJson?: string;  // Per-file fula share token JSON
}

export interface ProcessedShareDataV2 {
  version: 2;
  shareId: string;
  storageKey: string;  // IPFS CID from payload.cid or snapshot_binding.storage_key
  originalPath: string; // Original file path (payload.k) - used for fula_client scope validation
  bucket: string;
  name: string;
  tokenJson: string;   // Original token JSON for fula_client
  secretKey: Uint8Array; // Link private key
  expiresAt?: number;  // Unix timestamp
  contentType?: string;
  isFolder?: boolean;  // true if this is a folder share
  files?: FolderFileEntry[]; // File manifest for folder shares
}

/**
 * Share token structure
 */
export interface ShareToken {
  id: string;
  pathScope: string;
  permissions: 'readOnly' | 'readWrite' | 'full';
  wrappedDek: string;           // Base64 encrypted DEK
  recipientPublicKey?: string;  // Base64 recipient public key
  issuedAt: string;
  expiresAt: string;
  shareType: 'recipient' | 'publicLink' | 'passwordLink';
  shareMode: 'temporal' | 'snapshot';
}

/**
 * Outgoing share structure (stored in cloud)
 */
export interface OutgoingShare {
  id: string;
  token: ShareToken;
  cid: string;               // Content CID
  name?: string;             // Content name
  bucket: string;
  recipientName: string;
  recipientEmail?: string;   // Email of recipient (for direct shares)
  recipientDid?: string;     // DID of recipient (for direct shares)
  label?: string;
  sharedAt: string;
  expiresAt?: string;        // When share expires
  isRevoked: boolean;
  isPasswordProtected?: boolean;
  linkSecretKey?: string;    // Base64 - for public links
  passwordSalt?: string;     // Base64 - for password links
  shareUrl?: string;         // Full share URL
}

/**
 * Audio track structure
 */
export interface AudioTrack {
  id: string;
  path: string;
  name: string;
  artist?: string;
  album?: string;
  duration: number;
  artworkPath?: string;
}

/**
 * Playlist structure
 */
export interface Playlist {
  id: string;
  name: string;
  description?: string;
  tracks: AudioTrack[];
  createdAt: string;
  updatedAt: string;
  cloudKey?: string;
  isSyncedToCloud: boolean;
}

/**
 * Parse share URL and extract shareId and payload
 */
export function parseShareUrl(url: string): { shareId: string; payload: SharePayload } | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    // Expected format: /view/{shareId}
    if (pathParts.length < 2 || pathParts[0] !== 'view') {
      console.error('[parseShareUrl] Invalid path format:', urlObj.pathname);
      return null;
    }

    const shareId = pathParts[1];
    const fragment = urlObj.hash.startsWith('#') ? urlObj.hash.slice(1) : urlObj.hash;

    if (!fragment) {
      console.error('[parseShareUrl] No fragment in URL');
      return null;
    }

    console.log('[parseShareUrl] Fragment length:', fragment.length);
    console.log('[parseShareUrl] Fragment preview:', fragment.substring(0, 100) + '...');

    // Decode base64url payload
    const payloadJson = base64UrlDecode(fragment);
    console.log('[parseShareUrl] Decoded JSON:', payloadJson.substring(0, 200));

    const payload = JSON.parse(payloadJson) as SharePayload;
    console.log('[parseShareUrl] Parsed payload keys:', Object.keys(payload));

    return { shareId, payload };
  } catch (error) {
    console.error('[parseShareUrl] Failed to parse share URL:', error);
    return null;
  }
}

/**
 * Parse share from current page URL (for /view page)
 */
export function parseCurrentShareUrl(): { shareId: string; payload: SharePayload } | null {
  return parseShareUrl(window.location.href);
}

/**
 * Derive key from password using PBKDF2
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Decrypt a password-protected share payload
 *
 * Password-protected links have the format:
 * {v: 1, p: true, s: "<base64_salt>", e: "<base64_encrypted_inner_payload>"}
 *
 * The inner payload (after decryption) is a normal SharePayload with:
 * {v, t, sk, b, k, l}
 *
 * @param payload - The password-protected outer payload
 * @param password - The user's password
 * @returns The decrypted inner SharePayload
 */
export async function decryptPasswordProtectedPayload(
  payload: SharePayload,
  password: string
): Promise<SharePayload> {
  if (!payload.p) {
    throw new Error('Not a password-protected payload');
  }

  if (!payload.s || !payload.e) {
    throw new Error('Missing salt or encrypted data in password-protected payload');
  }

  console.log('[decryptPasswordProtectedPayload] Decrypting password-protected payload...');

  // Decode salt and encrypted payload
  const salt = base64ToUint8Array(payload.s);
  const encryptedPayload = base64ToUint8Array(payload.e);

  console.log('[decryptPasswordProtectedPayload] Salt length:', salt.length);
  console.log('[decryptPasswordProtectedPayload] Encrypted payload length:', encryptedPayload.length);

  // Derive key from password
  const passwordKey = await deriveKeyFromPassword(password, salt);

  // Decrypt inner payload using AES-GCM
  // FxFiles format: [12-byte nonce][16-byte tag][ciphertext]
  try {
    const decryptedBytes = await decrypt(encryptedPayload, passwordKey);
    const innerJson = new TextDecoder().decode(decryptedBytes);
    console.log('[decryptPasswordProtectedPayload] Decrypted inner payload length:', innerJson.length);

    const innerPayload = JSON.parse(innerJson) as SharePayload;
    console.log('[decryptPasswordProtectedPayload] Inner payload keys:', Object.keys(innerPayload));

    return innerPayload;
  } catch (error) {
    console.error('[decryptPasswordProtectedPayload] Decryption failed:', error);
    throw new Error('Invalid password');
  }
}

/**
 * Process v2 share payload using fula_client
 *
 * V2 format uses fula_client's ShareToken format:
 * - t: JSON string from createShareTokenWithMode()
 * - sk: link private key (used as secretKey for createShareClient)
 * - storageKey from token.snapshot_binding.storage_key
 *
 * Decryption is handled by fula_client.getWithToken()
 */
export async function processSharePayloadV2(
  payload: SharePayload,
  shareId: string
): Promise<ProcessedShareDataV2> {
  console.log('[processSharePayloadV2] Processing v2 payload');

  if (!payload.sk) {
    throw new Error('Share payload missing secret key (sk)');
  }

  if (typeof payload.t !== 'string') {
    throw new Error('V2 payload requires token (t) to be a JSON string');
  }

  const tokenJson = payload.t;

  // Parse token to extract metadata
  let token: any;
  try {
    token = JSON.parse(tokenJson);
  } catch (e) {
    throw new Error('Invalid ShareToken JSON');
  }

  console.log('[processSharePayloadV2] Token parsed:', {
    id: token.id,
    mode: token.mode,
    hasSnapshotBinding: !!token.snapshot_binding,
    snapshotStorageKey: token.snapshot_binding?.storage_key,
    expiresAt: token.expires_at,
    pathScope: token.path_scope,
  });

  console.log('[processSharePayloadV2] Payload fields:', {
    k: payload.k,       // Original path for DEK derivation
    cid: payload.cid,   // Storage key for fetching
  });

  // V2 payload format:
  // - payload.k = original filename path (used internally by fula_client for DEK derivation)
  // - payload.cid = storage key/CID (used to fetch the encrypted file from IPFS)
  // These are different values! The file is uploaded with key=filename but stored at CID
  const storageKey = payload.cid || token.snapshot_binding?.storage_key || token.path_scope;
  if (!storageKey) {
    throw new Error('V2 share: no storage key found in payload.cid, snapshot_binding, or path_scope');
  }
  console.log('[processSharePayloadV2] Using storage key:', storageKey, '(from', payload.cid ? 'payload.cid' : (token.snapshot_binding?.storage_key ? 'snapshot_binding' : 'path_scope'), ')');

  // Decode secret key
  const secretKey = base64ToUint8Array(payload.sk);
  if (secretKey.length !== 32) {
    throw new Error(`Invalid secret key length: ${secretKey.length} (expected 32)`);
  }

  // Determine filename
  const name = payload.f || payload.l || extractFilename(payload.k) || 'shared_file';

  // Original path for fula_client scope validation (must match token.path_scope)
  const originalPath = payload.k || token.path_scope;
  if (!originalPath) {
    throw new Error('V2 share: no original path found in payload.k or token.path_scope');
  }
  console.log('[processSharePayloadV2] Original path:', originalPath);

  // Parse folder manifest if present
  const isFolder = payload.folder === true;
  const files: FolderFileEntry[] | undefined = isFolder && Array.isArray(payload.files)
    ? payload.files.map((f: { n: string; c: string; s: number; t?: string }) => ({
        name: f.n,
        cid: f.c,
        size: f.s,
        tokenJson: f.t || undefined,
      }))
    : undefined;

  if (isFolder) {
    console.log('[processSharePayloadV2] Folder share with', files?.length ?? 0, 'files');
  }

  return {
    version: 2,
    shareId,
    storageKey,
    originalPath,
    bucket: payload.b || '',
    name,
    tokenJson,
    secretKey,
    expiresAt: token.expires_at,
    contentType: undefined, // V2 tokens don't include content type in the standard format
    isFolder,
    files,
  };
}

/**
 * Fetch and decrypt v2 shared content using fula_client
 *
 * Uses server-side proxy to fetch encrypted content from internal S3,
 * then decrypts client-side using fula_client.
 *
 * Two-step approach (as FxFiles does):
 * 1. acceptShare(client, tokenJson) → AcceptedShare handle
 * 2. getWithShare(client, bucket, storageKey, share) → decrypted data
 *
 * URL structure for proxy:
 * - Endpoint: /api/share/v2/fetch
 * - fula_client builds: {endpoint}/{bucket}/{storageKey}
 * - Final URL: /api/share/v2/fetch/{bucket}/{storageKey}
 * - Server uses {storageKey} (CID) to fetch from S3
 */
export async function fetchSharedContentV2(
  shareData: ProcessedShareDataV2
): Promise<{ data: Uint8Array; mimeType: string; filename: string }> {
  console.log('[fetchSharedContentV2] Fetching with fula_client:', {
    bucket: shareData.bucket,
    storageKey: shareData.storageKey,
    name: shareData.name,
  });

  // Use server-side proxy to fetch encrypted content from internal S3
  // fula_client builds URL as: {endpoint}/{bucket}/{storageKey}
  // storageKey is the CID, which matches token.path_scope
  const proxyEndpoint = `${window.location.origin}/api/share/v2/fetch`;
  console.log('[fetchSharedContentV2] Using proxy endpoint:', proxyEndpoint);

  // Create client with link's private key, pointing to our proxy
  const client = await createShareClient(shareData.secretKey, proxyEndpoint);

  // Step 1: Accept the share token to get an AcceptedShare handle
  console.log('[fetchSharedContentV2] Step 1: Accepting share token...');
  const acceptedShare = await acceptShareToken(client, shareData.tokenJson);
  console.log('[fetchSharedContentV2] Share accepted successfully');

  // Step 2: Fetch and decrypt using the accepted share
  // Pass storageKey (CID) - token.path_scope is the CID, not the filename
  // The originalPath is only for display purposes
  console.log('[fetchSharedContentV2] Step 2: Fetching with accepted share...');
  console.log('[fetchSharedContentV2] Calling getWithShare with storageKey:', shareData.storageKey);
  const decryptedData = await decryptWithAcceptedShare(
    client,
    shareData.bucket,
    shareData.storageKey,  // Use CID - must match token.path_scope
    acceptedShare
  );

  console.log('[fetchSharedContentV2] Decrypted data length:', decryptedData.length);

  // Debug: Log first 20 bytes to verify decryption
  const firstBytes = Array.from(decryptedData.slice(0, 20))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
  console.log('[fetchSharedContentV2] First 20 bytes (hex):', firstBytes);
  // PNG magic: 89 50 4e 47 0d 0a 1a 0a
  // JPEG magic: ff d8 ff
  // GIF magic: 47 49 46 38

  // Detect MIME type from decrypted content
  const mimeType = shareData.contentType || detectMimeType(decryptedData);
  console.log('[fetchSharedContentV2] Detected MIME type:', mimeType);

  const filename = shareData.name || `shared_file${getExtensionFromMimeType(mimeType)}`;

  return { data: decryptedData, mimeType, filename };
}

/**
 * Process share payload and unwrap the DEK (v1 format - deprecated)
 *
 * FxFiles uses HPKE (X25519 ECDH + HKDF) for key exchange:
 * 1. sk (secret key) is the link's private key
 * 2. ephemeralPublicKey is the sender's ephemeral public key
 * 3. X25519(sk, ephemeralPublicKey) → shared secret
 * 4. HKDF(sharedSecret, salt='fula-hpke-v1', info='wrap-key') → wrapKey
 * 5. AES-GCM decrypt(wrappedDek, wrapKey) → DEK
 */
export async function processSharePayload(
  payload: SharePayload,
  shareId: string
): Promise<ProcessedShareData> {
  // V1 format expects t to be an object, not a string
  if (typeof payload.t === 'string') {
    throw new Error('V1 processSharePayload received string token - use processSharePayloadV2 for v2 format');
  }

  const tokenData = payload.t as ShareTokenData | undefined;

  // Extract CID from snapshotBinding if available (for snapshot mode)
  const cid = tokenData?.snapshotBinding?.storageKey;

  console.log('[processSharePayload] Payload (v1):', {
    v: payload.v,
    hasSk: !!payload.sk,
    skLength: payload.sk?.length,
    bucket: payload.b,
    path: payload.k,
    label: payload.l,
    tokenId: tokenData?.id,
    shareMode: tokenData?.shareMode,
    hasSnapshotBinding: !!tokenData?.snapshotBinding,
    cid: cid,
    hasWrappedDek: !!tokenData?.wrappedDek,
    hasEphemeralPublicKey: !!tokenData?.ephemeralPublicKey,
    fileName: tokenData?.fileName,
    contentType: tokenData?.contentType,
  });

  if (!payload.sk) {
    throw new Error('Share payload missing secret key (sk)');
  }

  if (!tokenData?.wrappedDek) {
    throw new Error('Share payload missing wrapped DEK');
  }

  if (!tokenData?.ephemeralPublicKey) {
    throw new Error('Share payload missing ephemeral public key');
  }

  // Decode the secret key (link private key)
  console.log('[processSharePayload] Decoding secret key (sk)...');
  const skBytes = base64ToUint8Array(payload.sk);
  console.log('[processSharePayload] Secret key length:', skBytes.length, 'bytes');

  // Decode the ephemeral public key
  console.log('[processSharePayload] Decoding ephemeral public key...');
  const ephemeralPublicKeyBytes = base64ToUint8Array(tokenData.ephemeralPublicKey);
  console.log('[processSharePayload] Ephemeral public key length:', ephemeralPublicKeyBytes.length, 'bytes');

  // Derive shared secret using X25519 ECDH
  console.log('[processSharePayload] Deriving shared secret via X25519...');
  const sharedSecret = await deriveSharedSecret(skBytes, ephemeralPublicKeyBytes);
  console.log('[processSharePayload] Shared secret length:', sharedSecret.length, 'bytes');

  // Derive wrap key from shared secret using HKDF
  console.log('[processSharePayload] Deriving wrap key via HKDF...');
  const wrapKeyBytes = await deriveWrapKey(sharedSecret);
  console.log('[processSharePayload] Wrap key length:', wrapKeyBytes.length, 'bytes');

  // Import the wrap key as AES key
  const wrapKey = await importKey(wrapKeyBytes);

  // Decrypt the wrapped DEK
  console.log('[processSharePayload] Decrypting wrapped DEK...');
  const wrappedDekBytes = base64ToUint8Array(tokenData.wrappedDek);
  console.log('[processSharePayload] Wrapped DEK length:', wrappedDekBytes.length, 'bytes');

  const dekBytes = await decrypt(wrappedDekBytes, wrapKey);
  console.log('[processSharePayload] Decrypted DEK length:', dekBytes.length, 'bytes');

  // Import the DEK
  const dek = await importKey(dekBytes);

  return {
    shareId,
    cid,
    bucket: payload.b || '',
    path: payload.k || '',
    name: tokenData.fileName || payload.l || extractFilename(payload.k) || 'shared_file',
    dek,
    expiresAt: tokenData.expiresAt,
    contentType: tokenData.contentType,
  };
}

/**
 * Fetch and decrypt shared content
 */
export async function fetchSharedContent(
  shareData: ProcessedShareData
): Promise<{ data: Uint8Array; mimeType: string; filename: string }> {
  let url: string;

  // If we have a CID, fetch directly from IPFS gateway (like Pins.tsx does)
  if (shareData.cid) {
    url = `https://ipfs.cloud.fx.land/gateway/${shareData.cid}`;
    console.log('[fetchSharedContent] Fetching by CID:', url);
  } else {
    // Fallback: Use our backend proxy endpoint
    const params = new URLSearchParams({
      bucket: shareData.bucket,
      path: shareData.path,
    });
    url = `/api/share/${shareData.shareId}/content?${params}`;
    console.log('[fetchSharedContent] Fetching via backend proxy:', url);
  }

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[fetchSharedContent] Fetch failed:', response.status, errorText);
    throw new Error(`Failed to fetch shared content: ${response.status}`);
  }

  const encryptedData = new Uint8Array(await response.arrayBuffer());
  console.log('[fetchSharedContent] Encrypted data length:', encryptedData.length);

  const decryptedContent = await decrypt(encryptedData, shareData.dek);
  console.log('[fetchSharedContent] Decrypted content length:', decryptedContent.length);

  // Use contentType from share data if available, otherwise detect
  const mimeType = shareData.contentType || detectMimeType(decryptedContent);
  console.log('[fetchSharedContent] MIME type:', mimeType);

  // Get filename
  const filename = shareData.name || `shared_file${getExtensionFromMimeType(mimeType)}`;

  return { data: decryptedContent, mimeType, filename };
}

/**
 * Check if a share token is expired
 */
export function isShareExpired(token: ShareToken): boolean {
  if (!token.expiresAt) return false;
  return new Date(token.expiresAt).getTime() < Date.now();
}

/**
 * Check if share allows the requested path
 */
export function isPathAllowed(token: ShareToken, requestedPath: string): boolean {
  const scope = token.pathScope.toLowerCase();
  const requested = requestedPath.toLowerCase();

  // Path must start with the scope
  return requested.startsWith(scope) || scope === '/' || scope === '*';
}

/**
 * Get time until share expires (in seconds)
 */
export function getTimeUntilExpiry(token: ShareToken): number | null {
  if (!token.expiresAt) return null;
  const expiry = new Date(token.expiresAt).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((expiry - now) / 1000));
}

/**
 * Format expiry time for display
 */
export function formatExpiry(token: ShareToken): string {
  const seconds = getTimeUntilExpiry(token);
  if (seconds === null) return 'Never';
  if (seconds <= 0) return 'Expired';

  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
  return `${Math.floor(seconds / 86400)} days`;
}

// ============ Utility Functions ============

/**
 * Base64URL decode
 */
export function base64UrlDecode(str: string): string {
  if (!str) {
    throw new Error('Empty string to decode');
  }

  // Convert base64url to base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  while (base64.length % 4) {
    base64 += '=';
  }

  // Remove any whitespace
  base64 = base64.replace(/\s/g, '');

  try {
    return atob(base64);
  } catch (error) {
    console.error('[base64UrlDecode] Failed to decode, first 100 chars:', str.substring(0, 100));
    throw new Error(`Failed to decode base64url: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

/**
 * Base64URL encode
 */
export function base64UrlEncode(str: string): string {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  if (!base64) {
    throw new Error('Empty base64 string');
  }

  // Handle base64url format
  let normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) {
    normalized += '=';
  }

  // Remove any whitespace or newlines
  normalized = normalized.replace(/\s/g, '');

  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (error) {
    console.error('[base64ToUint8Array] Failed to decode:', base64.substring(0, 50) + '...');
    throw new Error(`Invalid base64 string: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Convert Uint8Array to base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Extract filename from path
 */
export function extractFilename(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * Detect MIME type from file magic bytes (extended version)
 */
export function detectMimeType(data: Uint8Array): string {
  if (data.length < 12) return 'application/octet-stream';

  const header = data.slice(0, 16);

  // PNG
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
    return 'image/png';
  }

  // JPEG
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
    return 'image/jpeg';
  }

  // GIF
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
    return 'image/gif';
  }

  // WebP
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) {
    return 'image/webp';
  }

  // BMP
  if (header[0] === 0x42 && header[1] === 0x4D) {
    return 'image/bmp';
  }

  // PDF
  if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
    return 'application/pdf';
  }

  // ZIP/Office documents
  if (header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04) {
    // Could be ZIP, DOCX, XLSX, PPTX - need to check further
    return detectOfficeType(data);
  }

  // MP4/MOV (ftyp box)
  if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) {
    return 'video/mp4';
  }

  // WebM
  if (header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3) {
    return 'video/webm';
  }

  // AVI
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x41 && header[9] === 0x56 && header[10] === 0x49) {
    return 'video/avi';
  }

  // MP3 (ID3 tag)
  if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
    return 'audio/mpeg';
  }

  // MP3 (no ID3, starts with frame sync)
  if (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) {
    return 'audio/mpeg';
  }

  // WAV
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x57 && header[9] === 0x41 && header[10] === 0x56 && header[11] === 0x45) {
    return 'audio/wav';
  }

  // OGG
  if (header[0] === 0x4F && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53) {
    return 'audio/ogg';
  }

  // Try to detect if it's text/UTF-8
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(data.slice(0, Math.min(1000, data.length)));

    // Check for common text patterns
    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
      return 'text/html';
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      return 'application/json';
    }
    if (text.startsWith('<?xml')) {
      return 'application/xml';
    }

    return 'text/plain';
  } catch {
    // Not valid UTF-8
  }

  return 'application/octet-stream';
}

/**
 * Detect Office document type from ZIP file
 */
function detectOfficeType(data: Uint8Array): string {
  // Try to read [Content_Types].xml from the ZIP to determine Office type
  // This is a simplified check - in production you might want to use a ZIP library

  const textDecoder = new TextDecoder();
  const text = textDecoder.decode(data.slice(0, Math.min(10000, data.length)));

  if (text.includes('word/document.xml') || text.includes('application/vnd.openxmlformats-officedocument.wordprocessingml')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; // .docx
  }
  if (text.includes('xl/workbook.xml') || text.includes('application/vnd.openxmlformats-officedocument.spreadsheetml')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; // .xlsx
  }
  if (text.includes('ppt/presentation.xml') || text.includes('application/vnd.openxmlformats-officedocument.presentationml')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; // .pptx
  }

  return 'application/zip';
}

/**
 * Check if MIME type is viewable inline
 */
export function isViewableInline(mimeType: string): boolean {
  const viewableTypes = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    'text/plain',
    'text/html',
    'text/markdown',
    'application/pdf',
    'application/json',
  ];

  return viewableTypes.includes(mimeType);
}

/**
 * Get viewer type for a MIME type
 */
export type ViewerType = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'document' | 'download';

export function getViewerType(mimeType: string): ViewerType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('wordprocessingml') || mimeType.includes('presentationml') || mimeType.includes('spreadsheetml')) {
    return 'document';
  }
  return 'download';
}

/**
 * Create object URL for blob viewing
 */
export function createBlobUrl(data: Uint8Array, mimeType: string): string {
  const blob = new Blob([data], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Revoke object URL to free memory
 */
export function revokeBlobUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/**
 * Parse raw outgoing shares data from API
 */
export function parseOutgoingShares(data: unknown[]): OutgoingShare[] {
  if (!Array.isArray(data)) return [];

  return data.map((item: unknown) => {
    const share = item as Record<string, unknown>;
    const token = (share.token || {}) as Record<string, unknown>;

    return {
      id: String(share.id || ''),
      token: {
        id: String(token.id || ''),
        pathScope: String(token.pathScope || '/'),
        permissions: (token.permissions as ShareToken['permissions']) || 'readOnly',
        wrappedDek: String(token.wrappedDek || ''),
        recipientPublicKey: token.recipientPublicKey ? String(token.recipientPublicKey) : undefined,
        issuedAt: String(token.issuedAt || new Date().toISOString()),
        expiresAt: String(token.expiresAt || ''),
        shareType: (token.shareType as ShareToken['shareType']) || 'publicLink',
        shareMode: (token.shareMode as ShareToken['shareMode']) || 'temporal',
      },
      cid: String(share.cid || ''),
      name: share.name ? String(share.name) : undefined,
      bucket: String(share.bucket || ''),
      recipientName: String(share.recipientName || ''),
      recipientEmail: share.recipientEmail ? String(share.recipientEmail) : undefined,
      recipientDid: share.recipientDid ? String(share.recipientDid) : undefined,
      label: share.label ? String(share.label) : undefined,
      sharedAt: String(share.sharedAt || new Date().toISOString()),
      expiresAt: share.expiresAt ? String(share.expiresAt) : undefined,
      isRevoked: Boolean(share.isRevoked),
      isPasswordProtected: Boolean(share.isPasswordProtected || token.shareType === 'passwordLink'),
      linkSecretKey: share.linkSecretKey ? String(share.linkSecretKey) : undefined,
      passwordSalt: share.passwordSalt ? String(share.passwordSalt) : undefined,
      shareUrl: share.shareUrl ? String(share.shareUrl) : undefined,
    };
  });
}

/**
 * Parse raw playlists data from API
 */
// ============================================================================
// COLLABORATION TYPES & HELPERS
// ============================================================================

/**
 * Collaboration payload (in URL fragment for /collab/:groupId links)
 */
export interface CollaborationPayload {
  v: number;
  type: 'collab';
  g: string;        // Group ID
  t: string;        // Manifest share token (fula_client JSON)
  sk: string;       // Base64 secret key (link private key)
  b: string;        // Manifest bucket
  k: string;        // Manifest key (path)
  n: string;        // Group name
}

/**
 * A file entry in the collaboration manifest
 */
export interface CollaborationFile {
  id: string;
  fileName: string;
  contentType?: string;
  bucket: string;
  storageKey: string;
  pathScope?: string;
  addedByPublicKey: string;
  addedAt: string;
  fileSize: number;
  encType: 'fula' | 'collab';
  shareTokenJson?: string;
}

/**
 * Collaboration group manifest (stored in cloud)
 */
export interface CollaborationManifest {
  id: string;
  name: string;
  ownerPublicKey: string;
  manifestBucket: string;
  manifestKey: string;
  createdAt: string;
  expiresAt?: string;
  isRevoked: boolean;
  files: CollaborationFile[];
  version: number;
  updatedAt: string;
}

/**
 * Check if a decoded payload is a collaboration payload
 */
export function isCollabPayload(payload: Record<string, unknown>): payload is CollaborationPayload {
  return payload.type === 'collab' && typeof payload.g === 'string';
}

/**
 * Parse the current page URL as a collaboration link
 * URL format: /collab/:groupId#{base64url-payload}
 */
export function parseCollabUrl(): { groupId: string; payload: CollaborationPayload } | null {
  try {
    const path = window.location.pathname;
    const match = path.match(/^\/collab\/([^/]+)/);
    if (!match) return null;

    const groupId = match[1];
    const fragment = window.location.hash.slice(1); // Remove leading #
    if (!fragment) return null;

    const decoded = base64UrlDecode(fragment);
    const payload = JSON.parse(decoded);

    if (!isCollabPayload(payload)) return null;

    return { groupId, payload };
  } catch (e) {
    console.error('[parseCollabUrl] Failed:', e);
    return null;
  }
}

/**
 * Derive a per-file encryption key from the link secret using HKDF
 *
 * Must match the Flutter/Dart implementation:
 * HKDF-SHA256, info="collab-file-v1:{fileId}", salt=empty
 */
export async function deriveCollabFileKey(
  linkSecret: Uint8Array,
  fileId: string
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    linkSecret,
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`collab-file-v1:${fileId}`),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt file data with AES-256-GCM using a collab-derived key
 *
 * Output format: [12-byte nonce][ciphertext][16-byte tag]
 * (tag is appended by WebCrypto automatically in the ciphertext output)
 */
export async function encryptCollabFile(
  data: ArrayBuffer,
  key: CryptoKey
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    data
  );
  // WebCrypto returns ciphertext + tag concatenated
  const result = new Uint8Array(nonce.length + encrypted.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(encrypted), nonce.length);
  return result;
}

/**
 * Decrypt file data encrypted with collab key
 *
 * Input format: [12-byte nonce][ciphertext + 16-byte tag]
 */
export async function decryptCollabFile(
  encrypted: Uint8Array,
  key: CryptoKey
): Promise<ArrayBuffer> {
  const nonce = encrypted.slice(0, 12);
  const ciphertext = encrypted.slice(12);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertext
  );
}

/**
 * Fetch a collaboration manifest from the server
 */
export async function fetchCollabManifest(
  bucket: string,
  manifestKey: string
): Promise<CollaborationManifest> {
  const url = `/api/share/v2/fetch/${encodeURIComponent(bucket)}/${encodeURIComponent(manifestKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.status}`);
  }
  const text = await response.text();
  return JSON.parse(text) as CollaborationManifest;
}

/**
 * Upload an encrypted file to the collaboration endpoint
 */
export async function uploadCollabFile(
  groupId: string,
  fileId: string,
  fileName: string,
  contentType: string,
  encryptedData: Uint8Array
): Promise<{ storageKey: string; bucket: string }> {
  const response = await fetch(`/api/collab/${groupId}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-collab-filename': fileName,
      'x-collab-content-type': contentType,
      'x-collab-file-id': fileId,
    },
    body: encryptedData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Update a collaboration manifest on the server
 */
export async function updateCollabManifest(
  groupId: string,
  manifest: CollaborationManifest
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  const response = await fetch(`/api/collab/${groupId}/manifest`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Manifest update failed' }));
    throw new Error(err.error || `Manifest update failed: ${response.status}`);
  }
}

export function parsePlaylists(data: unknown[]): Playlist[] {
  if (!Array.isArray(data)) return [];

  return data.map((item: unknown) => {
    const playlist = item as Record<string, unknown>;
    const rawTracks = (playlist.tracks || []) as unknown[];

    const tracks: AudioTrack[] = rawTracks.map((track: unknown) => {
      const t = track as Record<string, unknown>;
      return {
        id: String(t.id || ''),
        path: String(t.path || ''),
        name: String(t.name || t.title || ''),
        artist: t.artist ? String(t.artist) : undefined,
        album: t.album ? String(t.album) : undefined,
        duration: Number(t.duration || 0),
        artworkPath: t.artworkPath ? String(t.artworkPath) : undefined,
      };
    });

    return {
      id: String(playlist.id || ''),
      name: String(playlist.name || 'Untitled'),
      description: playlist.description ? String(playlist.description) : undefined,
      tracks,
      createdAt: String(playlist.createdAt || new Date().toISOString()),
      updatedAt: String(playlist.updatedAt || new Date().toISOString()),
      cloudKey: playlist.cloudKey ? String(playlist.cloudKey) : undefined,
      isSyncedToCloud: Boolean(playlist.isSyncedToCloud),
    };
  });
}
