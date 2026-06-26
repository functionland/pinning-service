/**
 * Collaboration manifest + collab-file crypto — byte-exact Worker (TS) port.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This is the SAME crypto the FxFiles Dart app, the `pinning-webui` TypeScript
 * portal (`src/services/sharingService.ts`), and the Rust `fula-mcp`
 * (`crates/fula-mcp/src/manifest.rs`) already use in production, so all four
 * implementations interoperate byte-for-byte.
 *
 * It is COPIED (not imported) from `pinning-webui/src/services/sharingService.ts`
 * on purpose: that module is a browser service (it pulls in `window`, relative
 * `/api/*` fetches, and cookie auth) and cannot be imported across the module
 * graph into a Worker. The crypto primitives below are kept byte-identical to its
 * `deriveCollabFileKey` / `encrypt|decryptCollabFile` / `deriveManifestKey` /
 * `encrypt|decryptManifestPayload`; only the large-array base64 path is hardened
 * (chunked, to avoid a `String.fromCharCode(...huge)` stack blow-up on a big
 * manifest). The naming mirrors the Rust module (`enc1Encrypt`, `collabFileEncrypt`)
 * for cross-reference.
 *
 * ## Wire spec (identical across Dart / TS-web / Rust / this)
 *
 *  - Key derivation — HKDF-SHA256, IKM = the 32-byte link secret, salt = EMPTY
 *    (zero-length), info = UTF-8 of `manifest-enc-v1:{scopeId}` (manifest) or
 *    `collab-file-v1:{fileId}` (per-file), L = 32 bytes → an AES-256-GCM key.
 *  - Symmetric encryption — AES-256-GCM, 12-byte random nonce, NO AAD, on-wire
 *    layout `nonce(12) || ciphertext || tag(16)` (WebCrypto appends the 16-byte
 *    GCM tag to the ciphertext, matching the Dart `cryptography` package and the
 *    Rust `aes-gcm` crate).
 *  - Manifest envelope ("ENC1") — derive manifest key → AES-GCM-seal the
 *    `utf8(JSON)` → `"ENC1:" + base64_standard(nonce||ct||tag)`. `scopeId` is the
 *    `groupId`.
 *  - Collab file — derive per-file key → AES-GCM-seal the raw bytes → store the
 *    raw `nonce||ct||tag` (NO `ENC1:` prefix, NO base64; uploaded as binary).
 *
 * All of this runs on the Workers runtime's `crypto.subtle` (HKDF + AES-GCM are
 * both supported), so there is no WASM dependency for the manifest/collab-file
 * crypto — only the HPKE link-secret UNWRAP (see ./identity.ts) needs the fula
 * WASM/SDK.
 */

/** AES-GCM nonce length (96 bits) — the 12 leading bytes of every blob. */
const NONCE_LEN = 12;
/** AES-GCM authentication tag length (128 bits) — the trailing 16 bytes. */
const TAG_LEN = 16;
/** The mandatory prefix on an encrypted manifest envelope. */
export const ENC1_PREFIX = "ENC1:";

/** Raised for any collab-crypto failure (decrypt auth failure, bad envelope). */
export class CollabCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollabCryptoError";
  }
}

// ── Key derivation — HKDF-SHA256, empty salt ─────────────────────────────────

/**
 * Derive the per-file AES-256-GCM key from the link secret and `fileId`.
 * HKDF-SHA256, empty salt, info = `collab-file-v1:{fileId}`, 32 bytes.
 * Byte-identical to the web `deriveCollabFileKey` and the Rust
 * `derive_collab_file_key`.
 */
export async function deriveCollabFileKey(
  linkSecret: Uint8Array,
  fileId: string,
): Promise<CryptoKey> {
  return deriveAesGcmKey(linkSecret, `collab-file-v1:${fileId}`);
}

/**
 * Derive the manifest-encryption AES-256-GCM key from the link secret and
 * `scopeId` (the collaboration `groupId`). HKDF-SHA256, empty salt, info =
 * `manifest-enc-v1:{scopeId}`, 32 bytes. Byte-identical to the web
 * `deriveManifestKey` and the Rust `derive_manifest_key`.
 */
export async function deriveManifestKey(
  linkSecret: Uint8Array,
  scopeId: string,
): Promise<CryptoKey> {
  return deriveAesGcmKey(linkSecret, `manifest-enc-v1:${scopeId}`);
}

/** Shared HKDF-SHA256 (empty salt) → AES-256-GCM CryptoKey for a given `info`. */
async function deriveAesGcmKey(linkSecret: Uint8Array, info: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    bytesView(linkSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0), // EMPTY salt (matches Dart `Uint8List(0)` / Rust `Some(&[])`)
      info: new TextEncoder().encode(info),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── AES-256-GCM — nonce(12) || ciphertext || tag(16) ─────────────────────────

/**
 * AES-256-GCM seal with a fresh random 12-byte nonce, NO AAD. Returns
 * `nonce(12) || ciphertext || tag(16)`. WebCrypto appends the 16-byte tag to the
 * ciphertext, which is exactly the Dart/Rust layout.
 */
export async function aesGcmSeal(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, bytesView(plaintext)),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/**
 * AES-256-GCM open of a `nonce(12) || ciphertext || tag(16)` blob, NO AAD.
 * Throws {@link CollabCryptoError} on a truncated blob or auth failure.
 */
export async function aesGcmOpen(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new CollabCryptoError(
      `ciphertext too short: need at least ${NONCE_LEN + TAG_LEN} bytes, got ${blob.length}`,
    );
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const ctAndTag = blob.subarray(NONCE_LEN);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ctAndTag);
    return new Uint8Array(pt);
  } catch {
    // Opaque by construction — never reveal which check failed.
    throw new CollabCryptoError("AES-GCM authentication failed (wrong key or corrupt ciphertext)");
  }
}

// ── Public envelope API ──────────────────────────────────────────────────────

/**
 * Encrypt manifest JSON bytes into the `"ENC1:"` envelope:
 * `"ENC1:" + base64_standard(nonce||ct||tag)`. The CALLER owns JSON
 * canonicalization (see ./manifest.ts `serializeManifest`).
 */
export async function enc1Encrypt(
  manifestJson: Uint8Array,
  linkSecret: Uint8Array,
  scopeId: string,
): Promise<string> {
  const key = await deriveManifestKey(linkSecret, scopeId);
  const blob = await aesGcmSeal(key, manifestJson);
  return ENC1_PREFIX + base64StdEncode(blob);
}

/**
 * Decrypt an `"ENC1:"` manifest envelope back to the manifest JSON bytes.
 * Throws {@link CollabCryptoError} on a missing prefix, bad base64, or auth
 * failure.
 */
export async function enc1Decrypt(
  enc1: string,
  linkSecret: Uint8Array,
  scopeId: string,
): Promise<Uint8Array> {
  if (!enc1.startsWith(ENC1_PREFIX)) {
    throw new CollabCryptoError(`manifest envelope is missing the required "${ENC1_PREFIX}" prefix`);
  }
  const body = enc1.slice(ENC1_PREFIX.length);
  let blob: Uint8Array;
  try {
    blob = base64StdDecode(body);
  } catch (e) {
    throw new CollabCryptoError(`base64 decode failed: ${e instanceof Error ? e.message : "bad base64"}`);
  }
  const key = await deriveManifestKey(linkSecret, scopeId);
  return aesGcmOpen(key, blob);
}

/**
 * Encrypt raw collab-file bytes. Returns the raw `nonce(12) || ct || tag(16)`
 * blob (NO `ENC1:` prefix, NO base64 — it is uploaded as binary).
 */
export async function collabFileEncrypt(
  plaintext: Uint8Array,
  linkSecret: Uint8Array,
  fileId: string,
): Promise<Uint8Array> {
  const key = await deriveCollabFileKey(linkSecret, fileId);
  return aesGcmSeal(key, plaintext);
}

/**
 * Decrypt a raw collab-file `nonce(12) || ct || tag(16)` blob. Throws
 * {@link CollabCryptoError} on a truncated blob or auth failure.
 */
export async function collabFileDecrypt(
  blob: Uint8Array,
  linkSecret: Uint8Array,
  fileId: string,
): Promise<Uint8Array> {
  const key = await deriveCollabFileKey(linkSecret, fileId);
  return aesGcmOpen(key, blob);
}

// ── base64 (standard alphabet) + small helpers ───────────────────────────────

/** A `BufferSource` view over a Uint8Array (workerd's `crypto.subtle` accepts it). */
function bytesView(b: Uint8Array): Uint8Array {
  return b;
}

/**
 * Standard-alphabet base64 encode, chunked so a large manifest cannot blow the
 * call stack via `String.fromCharCode(...huge)` (the web copy's known footgun;
 * a manifest is a file index but can still be many KB).
 */
export function base64StdEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // 32 KiB per apply call
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Standard-alphabet base64 decode. Throws on invalid input. */
export function base64StdDecode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
