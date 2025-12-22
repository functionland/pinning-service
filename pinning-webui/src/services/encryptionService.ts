/**
 * Client-side encryption service for FxFiles compatibility
 * 
 * Implements the same encryption scheme as FxFiles Flutter app:
 * - Key derivation: PBKDF2 with HMAC-SHA256, 100,000 iterations, 256-bit key
 * - Encryption: AES-256-GCM
 * - Format: [12-byte nonce][16-byte MAC/tag][ciphertext]
 * 
 * All cryptographic operations happen client-side using Web Crypto API.
 * No encryption keys or passwords are ever sent to the server.
 */

const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH_BITS = 256;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_PREFIX = 'fula-files-v1:';

/**
 * Derives an encryption key from user credentials using PBKDF2
 * Compatible with FxFiles app key derivation
 * 
 * @param googleUserId - The Google user ID (from Google OAuth 'sub' claim)
 * @param userEmail - The user's email address (used as salt)
 * @returns Promise<CryptoKey> - The derived AES-GCM key
 */
export async function deriveEncryptionKey(
  googleUserId: string,
  userEmail: string
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  
  // Combined ID format: "google:{userId}" - matches FxFiles
  const combinedId = `google:${googleUserId}`;
  
  // Salt format: "fula-files-v1:{email}" - matches FxFiles
  const salt = encoder.encode(`${SALT_PREFIX}${userEmail}`);
  
  // Import the combined ID as the base key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(combinedId),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  
  // Derive the AES-GCM key using PBKDF2
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    true, // extractable - needed for storage
    ['encrypt', 'decrypt']
  );
  
  return derivedKey;
}

/**
 * Export a CryptoKey to raw bytes for storage
 */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(exported);
}

/**
 * Import raw key bytes back to a CryptoKey
 */
export async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Decrypts data encrypted by FxFiles app
 * 
 * Data format: [12-byte nonce][16-byte tag][ciphertext]
 * 
 * @param encryptedData - The encrypted data as Uint8Array
 * @param key - The AES-GCM CryptoKey
 * @returns Promise<Uint8Array> - The decrypted data
 */
export async function decrypt(
  encryptedData: Uint8Array,
  key: CryptoKey
): Promise<Uint8Array> {
  // Validate minimum length: nonce (12) + tag (16) = 28 bytes minimum
  if (encryptedData.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }
  
  // Extract nonce (first 12 bytes)
  const nonce = encryptedData.slice(0, NONCE_LENGTH);
  
  // Extract tag (next 16 bytes)
  const tag = encryptedData.slice(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH);
  
  // Extract ciphertext (remaining bytes)
  const ciphertext = encryptedData.slice(NONCE_LENGTH + TAG_LENGTH);
  
  // Web Crypto API expects ciphertext + tag concatenated
  // FxFiles stores: nonce | tag | ciphertext
  // We need: nonce, ciphertext | tag
  const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
  ciphertextWithTag.set(ciphertext, 0);
  ciphertextWithTag.set(tag, ciphertext.length);
  
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        tagLength: TAG_LENGTH * 8, // in bits
      },
      key,
      ciphertextWithTag
    );
    
    return new Uint8Array(decrypted);
  } catch (error) {
    throw new Error('Decryption failed: invalid key or corrupted data');
  }
}

/**
 * Encrypts data using the same format as FxFiles app
 * 
 * @param data - The data to encrypt
 * @param key - The AES-GCM CryptoKey
 * @returns Promise<Uint8Array> - Encrypted data in format: [nonce][tag][ciphertext]
 */
export async function encrypt(
  data: Uint8Array,
  key: CryptoKey
): Promise<Uint8Array> {
  // Generate random nonce
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  
  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      tagLength: TAG_LENGTH * 8,
    },
    key,
    data
  );
  
  const encryptedArray = new Uint8Array(encrypted);
  
  // Web Crypto returns: ciphertext | tag
  // We need to reformat to: nonce | tag | ciphertext (FxFiles format)
  const ciphertext = encryptedArray.slice(0, encryptedArray.length - TAG_LENGTH);
  const tag = encryptedArray.slice(encryptedArray.length - TAG_LENGTH);
  
  const result = new Uint8Array(NONCE_LENGTH + TAG_LENGTH + ciphertext.length);
  result.set(nonce, 0);
  result.set(tag, NONCE_LENGTH);
  result.set(ciphertext, NONCE_LENGTH + TAG_LENGTH);
  
  return result;
}

/**
 * Fetch and decrypt a file from IPFS gateway
 * 
 * @param cid - The IPFS CID
 * @param key - The AES-GCM CryptoKey
 * @param gatewayUrl - The IPFS gateway base URL
 * @returns Promise<{ data: Uint8Array; filename: string | null }>
 */
export async function fetchAndDecrypt(
  cid: string,
  key: CryptoKey,
  gatewayUrl: string = 'https://ipfs.cloud.fx.land/gateway'
): Promise<{ data: Uint8Array; mimeType: string }> {
  const response = await fetch(`${gatewayUrl}/${cid}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch CID: ${response.status} ${response.statusText}`);
  }
  
  const encryptedData = new Uint8Array(await response.arrayBuffer());
  const decryptedData = await decrypt(encryptedData, key);
  
  // Try to detect file type from decrypted content
  const mimeType = detectMimeType(decryptedData);
  
  return { data: decryptedData, mimeType };
}

/**
 * Detect MIME type from file magic bytes
 */
function detectMimeType(data: Uint8Array): string {
  if (data.length < 4) return 'application/octet-stream';
  
  // Check magic bytes
  const header = data.slice(0, 12);
  
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
  
  // PDF
  if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
    return 'application/pdf';
  }
  
  // ZIP (also used by docx, xlsx, etc)
  if (header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04) {
    return 'application/zip';
  }
  
  // MP4/MOV
  if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) {
    return 'video/mp4';
  }
  
  // MP3 (ID3 tag)
  if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
    return 'audio/mpeg';
  }
  
  // MP3 (no ID3, starts with frame sync)
  if (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) {
    return 'audio/mpeg';
  }
  
  // Try to detect if it's text/UTF-8
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(data.slice(0, Math.min(1000, data.length)));
    return 'text/plain';
  } catch {
    // Not valid UTF-8
  }
  
  return 'application/octet-stream';
}

/**
 * Get file extension from MIME type
 */
export function getExtensionFromMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'text/plain': '.txt',
    'application/octet-stream': '.bin',
  };
  
  return mimeToExt[mimeType] || '.bin';
}

/**
 * Trigger a file download in the browser
 */
export function downloadBlob(data: Uint8Array, filename: string, mimeType: string): void {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  
  URL.revokeObjectURL(url);
}
