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
 * Derive a shared secret using X25519 ECDH
 * This is used for share links where sk + ephemeralPublicKey → shared secret
 *
 * Note: Web Crypto doesn't natively support X25519, so we use a pure JS implementation
 */
export async function deriveSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<Uint8Array> {
  // X25519 scalar multiplication using pure JavaScript
  // This implements the Curve25519 ECDH key agreement
  return x25519(privateKey, publicKey);
}

/**
 * Derive wrap key from shared secret using HKDF
 * Matches FxFiles _deriveWrapKey function:
 * - Uses HKDF with HMAC-SHA256
 * - Salt: 'fula-hpke-v1'
 * - Info: 'wrap-key'
 * - Output: 32 bytes
 */
export async function deriveWrapKey(sharedSecret: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const salt = encoder.encode('fula-hpke-v1');
  const info = encoder.encode('wrap-key');

  // Import the shared secret as HKDF key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveBits']
  );

  // Derive 32 bytes using HKDF
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt,
      info: info,
    },
    keyMaterial,
    256 // 32 bytes = 256 bits
  );

  return new Uint8Array(derivedBits);
}

/**
 * Derive X25519 public key from a 32-byte seed
 */
export function derivePublicKeyFromSeed(seed: Uint8Array): Uint8Array {
  // X25519 base point (9)
  const basePoint = new Uint8Array(32);
  basePoint[0] = 9;
  return x25519(seed, basePoint);
}

/**
 * Derive the keypair seed for user ID computation
 * Uses different salt than encryption key: "fula-files-keypair-v1:{email}"
 */
export async function deriveKeypairSeed(
  googleUserId: string,
  userEmail: string
): Promise<Uint8Array> {
  const encoder = new TextEncoder();

  // Combined ID format: "google:{userId}"
  const combinedId = `google:${googleUserId}`;

  // Salt for keypair: "fula-files-keypair-v1:{email}" (different from encryption key!)
  const salt = encoder.encode(`fula-files-keypair-v1:${userEmail}`);

  // Import as PBKDF2 key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(combinedId),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Derive 32 bytes
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256 // 32 bytes
  );

  return new Uint8Array(derivedBits);
}

/**
 * Compute hashed user ID for shares path
 * Algorithm from FxFiles:
 * 1. Derive keypair seed with salt "fula-files-keypair-v1:{email}"
 * 2. Get X25519 public key from seed
 * 3. Base64 encode the public key
 * 4. SHA256 hash the base64 string (as UTF-8 bytes)
 * 5. Base64 encode hash, take first 16 chars, make URL-safe
 */
export async function computeHashedUserId(
  googleUserId: string,
  userEmail: string
): Promise<string> {
  // Step 1-2: Derive keypair seed and get public key
  const seed = await deriveKeypairSeed(googleUserId, userEmail);
  const publicKey = derivePublicKeyFromSeed(seed);

  // Step 3: Base64 encode the public key
  let binary = '';
  for (let i = 0; i < publicKey.length; i++) {
    binary += String.fromCharCode(publicKey[i]);
  }
  const publicKeyBase64 = btoa(binary);

  // Step 4: SHA256 hash the base64 string (as UTF-8 bytes)
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(publicKeyBase64));
  const hashArray = new Uint8Array(hashBuffer);

  // Step 5: Base64 encode hash, take first 16 chars, make URL-safe
  let hashBinary = '';
  for (let i = 0; i < hashArray.length; i++) {
    hashBinary += String.fromCharCode(hashArray[i]);
  }
  const hashBase64 = btoa(hashBinary)
    .replace(/\//g, '_')
    .replace(/\+/g, '-');

  return hashBase64.substring(0, 16);
}

// ============ X25519 Pure JS Implementation ============
// Based on TweetNaCl's Curve25519 implementation

function x25519(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  crypto_scalarmult(out, sk, pk);
  return out;
}

// Field element type (array of 16 numbers)
type GF = Float64Array;

function gf(init?: number[]): GF {
  const r = new Float64Array(16);
  if (init) {
    for (let i = 0; i < init.length; i++) r[i] = init[i];
  }
  return r;
}

const _0 = new Uint8Array(16);
const _9 = new Uint8Array(32);
_9[0] = 9;

const gf0 = gf();
const gf1 = gf([1]);
const _121665 = gf([0xdb41, 1]);

function A(o: GF, a: GF, b: GF): void {
  for (let i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

function Z(o: GF, a: GF, b: GF): void {
  for (let i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

function M(o: GF, a: GF, b: GF): void {
  let t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0,
      t8 = 0, t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0,
      t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0,
      t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0;
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5],
        b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11],
        b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];

  let v = a[0];
  t0 += v * b0; t1 += v * b1; t2 += v * b2; t3 += v * b3;
  t4 += v * b4; t5 += v * b5; t6 += v * b6; t7 += v * b7;
  t8 += v * b8; t9 += v * b9; t10 += v * b10; t11 += v * b11;
  t12 += v * b12; t13 += v * b13; t14 += v * b14; t15 += v * b15;
  v = a[1];
  t1 += v * b0; t2 += v * b1; t3 += v * b2; t4 += v * b3;
  t5 += v * b4; t6 += v * b5; t7 += v * b6; t8 += v * b7;
  t9 += v * b8; t10 += v * b9; t11 += v * b10; t12 += v * b11;
  t13 += v * b12; t14 += v * b13; t15 += v * b14; t16 += v * b15;
  v = a[2];
  t2 += v * b0; t3 += v * b1; t4 += v * b2; t5 += v * b3;
  t6 += v * b4; t7 += v * b5; t8 += v * b6; t9 += v * b7;
  t10 += v * b8; t11 += v * b9; t12 += v * b10; t13 += v * b11;
  t14 += v * b12; t15 += v * b13; t16 += v * b14; t17 += v * b15;
  v = a[3];
  t3 += v * b0; t4 += v * b1; t5 += v * b2; t6 += v * b3;
  t7 += v * b4; t8 += v * b5; t9 += v * b6; t10 += v * b7;
  t11 += v * b8; t12 += v * b9; t13 += v * b10; t14 += v * b11;
  t15 += v * b12; t16 += v * b13; t17 += v * b14; t18 += v * b15;
  v = a[4];
  t4 += v * b0; t5 += v * b1; t6 += v * b2; t7 += v * b3;
  t8 += v * b4; t9 += v * b5; t10 += v * b6; t11 += v * b7;
  t12 += v * b8; t13 += v * b9; t14 += v * b10; t15 += v * b11;
  t16 += v * b12; t17 += v * b13; t18 += v * b14; t19 += v * b15;
  v = a[5];
  t5 += v * b0; t6 += v * b1; t7 += v * b2; t8 += v * b3;
  t9 += v * b4; t10 += v * b5; t11 += v * b6; t12 += v * b7;
  t13 += v * b8; t14 += v * b9; t15 += v * b10; t16 += v * b11;
  t17 += v * b12; t18 += v * b13; t19 += v * b14; t20 += v * b15;
  v = a[6];
  t6 += v * b0; t7 += v * b1; t8 += v * b2; t9 += v * b3;
  t10 += v * b4; t11 += v * b5; t12 += v * b6; t13 += v * b7;
  t14 += v * b8; t15 += v * b9; t16 += v * b10; t17 += v * b11;
  t18 += v * b12; t19 += v * b13; t20 += v * b14; t21 += v * b15;
  v = a[7];
  t7 += v * b0; t8 += v * b1; t9 += v * b2; t10 += v * b3;
  t11 += v * b4; t12 += v * b5; t13 += v * b6; t14 += v * b7;
  t15 += v * b8; t16 += v * b9; t17 += v * b10; t18 += v * b11;
  t19 += v * b12; t20 += v * b13; t21 += v * b14; t22 += v * b15;
  v = a[8];
  t8 += v * b0; t9 += v * b1; t10 += v * b2; t11 += v * b3;
  t12 += v * b4; t13 += v * b5; t14 += v * b6; t15 += v * b7;
  t16 += v * b8; t17 += v * b9; t18 += v * b10; t19 += v * b11;
  t20 += v * b12; t21 += v * b13; t22 += v * b14; t23 += v * b15;
  v = a[9];
  t9 += v * b0; t10 += v * b1; t11 += v * b2; t12 += v * b3;
  t13 += v * b4; t14 += v * b5; t15 += v * b6; t16 += v * b7;
  t17 += v * b8; t18 += v * b9; t19 += v * b10; t20 += v * b11;
  t21 += v * b12; t22 += v * b13; t23 += v * b14; t24 += v * b15;
  v = a[10];
  t10 += v * b0; t11 += v * b1; t12 += v * b2; t13 += v * b3;
  t14 += v * b4; t15 += v * b5; t16 += v * b6; t17 += v * b7;
  t18 += v * b8; t19 += v * b9; t20 += v * b10; t21 += v * b11;
  t22 += v * b12; t23 += v * b13; t24 += v * b14; t25 += v * b15;
  v = a[11];
  t11 += v * b0; t12 += v * b1; t13 += v * b2; t14 += v * b3;
  t15 += v * b4; t16 += v * b5; t17 += v * b6; t18 += v * b7;
  t19 += v * b8; t20 += v * b9; t21 += v * b10; t22 += v * b11;
  t23 += v * b12; t24 += v * b13; t25 += v * b14; t26 += v * b15;
  v = a[12];
  t12 += v * b0; t13 += v * b1; t14 += v * b2; t15 += v * b3;
  t16 += v * b4; t17 += v * b5; t18 += v * b6; t19 += v * b7;
  t20 += v * b8; t21 += v * b9; t22 += v * b10; t23 += v * b11;
  t24 += v * b12; t25 += v * b13; t26 += v * b14; t27 += v * b15;
  v = a[13];
  t13 += v * b0; t14 += v * b1; t15 += v * b2; t16 += v * b3;
  t17 += v * b4; t18 += v * b5; t19 += v * b6; t20 += v * b7;
  t21 += v * b8; t22 += v * b9; t23 += v * b10; t24 += v * b11;
  t25 += v * b12; t26 += v * b13; t27 += v * b14; t28 += v * b15;
  v = a[14];
  t14 += v * b0; t15 += v * b1; t16 += v * b2; t17 += v * b3;
  t18 += v * b4; t19 += v * b5; t20 += v * b6; t21 += v * b7;
  t22 += v * b8; t23 += v * b9; t24 += v * b10; t25 += v * b11;
  t26 += v * b12; t27 += v * b13; t28 += v * b14; t29 += v * b15;
  v = a[15];
  t15 += v * b0; t16 += v * b1; t17 += v * b2; t18 += v * b3;
  t19 += v * b4; t20 += v * b5; t21 += v * b6; t22 += v * b7;
  t23 += v * b8; t24 += v * b9; t25 += v * b10; t26 += v * b11;
  t27 += v * b12; t28 += v * b13; t29 += v * b14; t30 += v * b15;

  t0  += 38 * t16; t1  += 38 * t17; t2  += 38 * t18; t3  += 38 * t19;
  t4  += 38 * t20; t5  += 38 * t21; t6  += 38 * t22; t7  += 38 * t23;
  t8  += 38 * t24; t9  += 38 * t25; t10 += 38 * t26; t11 += 38 * t27;
  t12 += 38 * t28; t13 += 38 * t29; t14 += 38 * t30;

  let c = 1;
  v = t0 + c + 65535; c = Math.floor(v / 65536); t0 = v - c * 65536;
  v = t1 + c + 65535; c = Math.floor(v / 65536); t1 = v - c * 65536;
  v = t2 + c + 65535; c = Math.floor(v / 65536); t2 = v - c * 65536;
  v = t3 + c + 65535; c = Math.floor(v / 65536); t3 = v - c * 65536;
  v = t4 + c + 65535; c = Math.floor(v / 65536); t4 = v - c * 65536;
  v = t5 + c + 65535; c = Math.floor(v / 65536); t5 = v - c * 65536;
  v = t6 + c + 65535; c = Math.floor(v / 65536); t6 = v - c * 65536;
  v = t7 + c + 65535; c = Math.floor(v / 65536); t7 = v - c * 65536;
  v = t8 + c + 65535; c = Math.floor(v / 65536); t8 = v - c * 65536;
  v = t9 + c + 65535; c = Math.floor(v / 65536); t9 = v - c * 65536;
  v = t10 + c + 65535; c = Math.floor(v / 65536); t10 = v - c * 65536;
  v = t11 + c + 65535; c = Math.floor(v / 65536); t11 = v - c * 65536;
  v = t12 + c + 65535; c = Math.floor(v / 65536); t12 = v - c * 65536;
  v = t13 + c + 65535; c = Math.floor(v / 65536); t13 = v - c * 65536;
  v = t14 + c + 65535; c = Math.floor(v / 65536); t14 = v - c * 65536;
  v = t15 + c + 65535; c = Math.floor(v / 65536); t15 = v - c * 65536;
  t0 += c - 1 + 37 * (c - 1);

  c = 1;
  v = t0 + c + 65535; c = Math.floor(v / 65536); t0 = v - c * 65536;
  v = t1 + c + 65535; c = Math.floor(v / 65536); t1 = v - c * 65536;
  v = t2 + c + 65535; c = Math.floor(v / 65536); t2 = v - c * 65536;
  v = t3 + c + 65535; c = Math.floor(v / 65536); t3 = v - c * 65536;
  v = t4 + c + 65535; c = Math.floor(v / 65536); t4 = v - c * 65536;
  v = t5 + c + 65535; c = Math.floor(v / 65536); t5 = v - c * 65536;
  v = t6 + c + 65535; c = Math.floor(v / 65536); t6 = v - c * 65536;
  v = t7 + c + 65535; c = Math.floor(v / 65536); t7 = v - c * 65536;
  v = t8 + c + 65535; c = Math.floor(v / 65536); t8 = v - c * 65536;
  v = t9 + c + 65535; c = Math.floor(v / 65536); t9 = v - c * 65536;
  v = t10 + c + 65535; c = Math.floor(v / 65536); t10 = v - c * 65536;
  v = t11 + c + 65535; c = Math.floor(v / 65536); t11 = v - c * 65536;
  v = t12 + c + 65535; c = Math.floor(v / 65536); t12 = v - c * 65536;
  v = t13 + c + 65535; c = Math.floor(v / 65536); t13 = v - c * 65536;
  v = t14 + c + 65535; c = Math.floor(v / 65536); t14 = v - c * 65536;
  v = t15 + c + 65535; c = Math.floor(v / 65536); t15 = v - c * 65536;
  t0 += c - 1 + 37 * (c - 1);

  o[0] = t0; o[1] = t1; o[2] = t2; o[3] = t3;
  o[4] = t4; o[5] = t5; o[6] = t6; o[7] = t7;
  o[8] = t8; o[9] = t9; o[10] = t10; o[11] = t11;
  o[12] = t12; o[13] = t13; o[14] = t14; o[15] = t15;
}

function S(o: GF, a: GF): void {
  M(o, a, a);
}

function inv25519(o: GF, i: GF): void {
  const c = gf();
  let a: number;
  for (a = 0; a < 16; a++) c[a] = i[a];
  for (a = 253; a >= 0; a--) {
    S(c, c);
    if (a !== 2 && a !== 4) M(c, c, i);
  }
  for (a = 0; a < 16; a++) o[a] = c[a];
}

function pack25519(o: Uint8Array, n: GF): void {
  let i: number, j: number, b: number;
  const m = gf(), t = gf();
  for (i = 0; i < 16; i++) t[i] = n[i];
  car25519(t);
  car25519(t);
  car25519(t);
  for (j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (i = 0; i < 16; i++) {
    o[2 * i] = t[i] & 0xff;
    o[2 * i + 1] = t[i] >> 8;
  }
}

function unpack25519(o: GF, n: Uint8Array): void {
  for (let i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}

function car25519(o: GF): void {
  let i: number, v: number, c = 1;
  for (i = 0; i < 16; i++) {
    v = o[i] + c + 65535;
    c = Math.floor(v / 65536);
    o[i] = v - c * 65536;
  }
  o[0] += c - 1 + 37 * (c - 1);
}

function sel25519(p: GF, q: GF, b: number): void {
  let t: number;
  const c = ~(b - 1);
  for (let i = 0; i < 16; i++) {
    t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

function crypto_scalarmult(q: Uint8Array, n: Uint8Array, p: Uint8Array): void {
  const z = new Uint8Array(32);
  const x = new Float64Array(80);
  let r: number, i: number;
  const a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();

  for (i = 0; i < 31; i++) z[i] = n[i];
  z[31] = (n[31] & 127) | 64;
  z[0] &= 248;

  unpack25519(x as unknown as GF, p);

  for (i = 0; i < 16; i++) {
    b[i] = x[i];
    d[i] = a[i] = c[i] = 0;
  }
  a[0] = d[0] = 1;

  for (i = 254; i >= 0; --i) {
    r = (z[i >>> 3] >>> (i & 7)) & 1;
    sel25519(a, b, r);
    sel25519(c, d, r);
    A(e, a, c);
    Z(a, a, c);
    A(c, b, d);
    Z(b, b, d);
    S(d, e);
    S(f, a);
    M(a, c, a);
    M(c, b, e);
    A(e, a, c);
    Z(a, a, c);
    S(b, a);
    Z(c, d, f);
    M(a, c, _121665);
    A(a, a, d);
    M(c, c, a);
    M(a, d, f);
    M(d, b, x as unknown as GF);
    S(b, e);
    sel25519(a, b, r);
    sel25519(c, d, r);
  }

  for (i = 0; i < 16; i++) {
    x[i + 16] = a[i];
    x[i + 32] = c[i];
    x[i + 48] = b[i];
    x[i + 64] = d[i];
  }

  const x32 = x.subarray(32) as unknown as GF;
  const x16 = x.subarray(16) as unknown as GF;
  inv25519(x32, x32);
  M(x16, x16, x32);
  pack25519(q, x16);
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
