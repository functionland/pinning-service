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

import { decrypt, importKey, getExtensionFromMimeType } from './encryptionService';

// Constants
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH_BITS = 256;
const SHARE_SALT_PREFIX = 'fula-share-v1:';

/**
 * Share payload structure (in URL fragment)
 */
export interface SharePayload {
  v: number;           // Version
  t: string;           // Encoded share token (JSON string)
  k?: string;          // Link secret key (base64) - for public links
  b: string;           // Bucket name
  p: string;           // Path scope
  pwd: boolean;        // Is password-protected
  salt?: string;       // Password salt (base64) - for password links
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
      return null;
    }

    const shareId = pathParts[1];
    const fragment = urlObj.hash.startsWith('#') ? urlObj.hash.slice(1) : urlObj.hash;

    if (!fragment) {
      return null;
    }

    // Decode base64url payload
    const payloadJson = base64UrlDecode(fragment);
    const payload = JSON.parse(payloadJson) as SharePayload;

    return { shareId, payload };
  } catch (error) {
    console.error('[SharingService] Failed to parse share URL:', error);
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
 * Decrypt password-protected payload
 */
export async function decryptPasswordPayload(
  encryptedPayload: string,
  password: string,
  salt: string
): Promise<SharePayload> {
  const saltBytes = base64ToUint8Array(salt);
  const encryptedBytes = base64ToUint8Array(encryptedPayload);

  const key = await deriveKeyFromPassword(password, saltBytes);
  const decrypted = await decrypt(encryptedBytes, key);

  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(decrypted)) as SharePayload;
}

/**
 * Get the DEK (Data Encryption Key) from share payload
 * For public links, the key is directly in the payload
 * For password links, need to decrypt first
 */
export async function getDekFromPayload(
  payload: SharePayload,
  password?: string
): Promise<CryptoKey> {
  let dekBase64: string;

  if (payload.pwd && password) {
    // Password-protected: the 'k' field is encrypted
    if (!payload.k || !payload.salt) {
      throw new Error('Password-protected share missing encrypted key or salt');
    }

    // Derive key from password
    const saltBytes = base64ToUint8Array(payload.salt);
    const passwordKey = await deriveKeyFromPassword(password, saltBytes);

    // Decrypt the wrapped DEK
    const encryptedDek = base64ToUint8Array(payload.k);
    const dekBytes = await decrypt(encryptedDek, passwordKey);
    dekBase64 = uint8ArrayToBase64(dekBytes);
  } else if (payload.k) {
    // Public link: key is directly available
    dekBase64 = payload.k;
  } else {
    throw new Error('Share payload missing encryption key');
  }

  // Import the DEK
  const dekBytes = base64ToUint8Array(dekBase64);
  return importKey(dekBytes);
}

/**
 * Fetch and decrypt shared content
 */
export async function fetchSharedContent(
  payload: SharePayload,
  password?: string,
  gatewayUrl: string = 'https://ipfs.cloud.fx.land/gateway'
): Promise<{ data: Uint8Array; mimeType: string; filename: string }> {
  // Get the DEK
  const dek = await getDekFromPayload(payload, password);

  // Parse the token to get file info
  const token = JSON.parse(payload.t) as ShareToken;

  // Construct the storage path
  const path = payload.p.startsWith('/') ? payload.p.slice(1) : payload.p;
  const bucket = payload.b;

  // Fetch from gateway (bucket/path or direct CID)
  const url = `${gatewayUrl}/${bucket}/${path}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch shared content: ${response.status}`);
  }

  const encryptedData = new Uint8Array(await response.arrayBuffer());
  const decryptedData = await decrypt(encryptedData, dek);

  // Detect MIME type
  const mimeType = detectMimeType(decryptedData);

  // Extract filename from path
  const filename = extractFilename(payload.p) || `shared_file${getExtensionFromMimeType(mimeType)}`;

  return { data: decryptedData, mimeType, filename };
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
  // Convert base64url to base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  while (base64.length % 4) {
    base64 += '=';
  }

  return atob(base64);
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
  // Handle base64url format
  let normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) {
    normalized += '=';
  }

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
