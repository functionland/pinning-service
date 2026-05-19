/**
 * Mode B / Mode C seed-as-identity crypto orchestration.
 *
 * Mirrors the FxFiles Dart implementation byte-for-byte. Any divergence
 * breaks cross-device determinism — a user signing in via FxFiles and
 * via pinning-webui MUST land on the same `effective_user_id` and produce
 * verifying signatures with the same Ed25519 keypair.
 *
 * Source-of-truth references:
 *   - Rust impl: fula-api/crates/fula-crypto/src/effective_user_id.rs
 *   - Dart impl:
 *       FxFiles/lib/core/utils/canonical_kek_input.dart
 *       FxFiles/lib/core/utils/seed_signing_input.dart
 *       FxFiles/lib/core/services/auth_service.dart (signInModeB, signInModeC,
 *         _buildSignedTranscript, _deriveSigningKeypair)
 *   - Server verifier: pinning-service/pinning-webui/server/services/seedAuth.ts
 *       (buildSignedTranscript)
 *
 * The WASM functions called below were added in
 * fula-api/crates/fula-js/src/lib.rs at the same time as this file
 * shipped — the npm package's WASM artifacts are rebuilt in-tree (see
 * crates/fula-js/pkg/) and copied into node_modules.
 */

import init, {
  computeEffectiveUserIdModeB as wasmComputeEffectiveUserIdModeB,
  computeEffectiveUserIdModeC as wasmComputeEffectiveUserIdModeC,
  deriveSigningSeed as wasmDeriveSigningSeed,
  ed25519PublicKey as wasmEd25519PublicKey,
  ed25519Sign as wasmEd25519Sign,
  deriveKey as wasmDeriveKey,
} from '@functionland/fula-client';

// ============================================================================
// WASM initialization (idempotent)
// ============================================================================

let wasmInitialized = false;

async function ensureWasm(): Promise<void> {
  if (wasmInitialized) return;
  await init();
  wasmInitialized = true;
}

// ============================================================================
// Encoding helpers
// ============================================================================

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hex string must have even length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  // Tolerate URL-safe variants and missing padding.
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ============================================================================
// Signing-key input strings (match FxFiles seed_signing_input.dart byte-for-byte)
// ============================================================================

/** Mode B signing-key input: `'b\0' + provider + '\0' + oauth_sub + '\0' + password`.
 *  Binding the signing-seed derivation to the OAuth identity prevents
 *  same-password users under different OAuth accounts from colliding on
 *  the same Ed25519 keypair (audit fix #3). */
export function modeBSigningInput(
  provider: string,
  oauthSub: string,
  password: string,
): string {
  return `b\x00${provider}\x00${oauthSub}\x00${password}`;
}

/** Mode C signing-key input: the seed alone. No OAuth identity to bind to.
 *  The leading `'b\0'` tag in Mode B keeps the two namespaces disjoint. */
export function modeCSigningInput(seed: string): string {
  return seed;
}

// ============================================================================
// Effective user-id derivations (call WASM)
// ============================================================================

export async function computeEffectiveUserIdModeB(
  provider: string,
  oauthSub: string,
  password: string,
): Promise<string> {
  await ensureWasm();
  const bytes = wasmComputeEffectiveUserIdModeB(provider, oauthSub, password);
  return bytesToHex(bytes);
}

export async function computeEffectiveUserIdModeC(
  seed: string,
): Promise<string> {
  await ensureWasm();
  const bytes = wasmComputeEffectiveUserIdModeC(seed);
  return bytesToHex(bytes);
}

// ============================================================================
// Signing keypair derivation
// ============================================================================

export interface SigningKeypair {
  /** 32-byte Ed25519 seed (input to from_bytes). */
  seed: Uint8Array;
  /** 32-byte Ed25519 public verifying key. */
  publicKey: Uint8Array;
}

/** Derive the Ed25519 keypair for Mode B sign-in/registration. Caller MUST
 *  pass the OAuth-bound signing input from `modeBSigningInput`, NOT the
 *  raw password (audit fix #3). */
export async function deriveSigningKeypairModeB(
  provider: string,
  oauthSub: string,
  password: string,
): Promise<SigningKeypair> {
  await ensureWasm();
  const input = modeBSigningInput(provider, oauthSub, password);
  const seed = wasmDeriveSigningSeed(input);
  const publicKey = wasmEd25519PublicKey(seed);
  return { seed, publicKey };
}

/** Derive the Ed25519 keypair for Mode C sign-in/registration. The input
 *  is the seed string directly. */
export async function deriveSigningKeypairModeC(
  seed: string,
): Promise<SigningKeypair> {
  await ensureWasm();
  const signingSeed = wasmDeriveSigningSeed(seed);
  const publicKey = wasmEd25519PublicKey(signingSeed);
  return { seed: signingSeed, publicKey };
}

// ============================================================================
// Signed transcript (matches server-side buildSignedTranscript byte-for-byte)
// ============================================================================

export type SeedAuthPurpose =
  | 'register-mode-b'
  | 'register-mode-c'
  | 'sign-in';

/** Construct the bytes the client signs with its seed-derived Ed25519
 *  private key. MUST match exactly what the issuer reconstructs in
 *  `pinning-service/server/services/seedAuth.ts`.
 *
 *  Layout:
 *    'fula.seed-auth.v1\0' || purpose || 0x00 ||
 *    effective_user_id_hex_ascii || 0x00 || challenge_bytes
 *
 *  The DOMAIN already ends in NUL; do not add another NUL after it. */
export function buildSignedTranscript(
  purpose: SeedAuthPurpose,
  effectiveUserIdHex: string,
  challenge: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const domain = enc.encode('fula.seed-auth.v1\0');
  const purposeBytes = enc.encode(purpose);
  const uidBytes = enc.encode(effectiveUserIdHex);
  const total =
    domain.length +
    purposeBytes.length +
    1 +
    uidBytes.length +
    1 +
    challenge.length;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(domain, o); o += domain.length;
  out.set(purposeBytes, o); o += purposeBytes.length;
  out[o++] = 0;
  out.set(uidBytes, o); o += uidBytes.length;
  out[o++] = 0;
  out.set(challenge, o);
  return out;
}

/** Sign the transcript bytes with the keypair's 32-byte seed.
 *  Returns the 64-byte Ed25519 detached signature. */
export async function signTranscript(
  signingSeed: Uint8Array,
  transcript: Uint8Array,
): Promise<Uint8Array> {
  await ensureWasm();
  return wasmEd25519Sign(signingSeed, transcript);
}

// ============================================================================
// High-level orchestrators — call these from UI components
// ============================================================================

export interface ModeBRegistrationProof {
  effectiveUserIdHex: string;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export async function buildModeBRegistrationProof(args: {
  provider: 'google' | 'apple';
  oauthSub: string;
  password: string;
  challenge: Uint8Array;
}): Promise<ModeBRegistrationProof> {
  const { provider, oauthSub, password, challenge } = args;
  const effectiveUserIdHex = await computeEffectiveUserIdModeB(
    provider,
    oauthSub,
    password,
  );
  const keypair = await deriveSigningKeypairModeB(provider, oauthSub, password);
  const transcript = buildSignedTranscript(
    'register-mode-b',
    effectiveUserIdHex,
    challenge,
  );
  const signature = await signTranscript(keypair.seed, transcript);
  return { effectiveUserIdHex, publicKey: keypair.publicKey, signature };
}

export interface ModeCRegistrationProof {
  effectiveUserIdHex: string;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export async function buildModeCRegistrationProof(args: {
  seed: string;
  challenge: Uint8Array;
}): Promise<ModeCRegistrationProof> {
  const { seed, challenge } = args;
  const effectiveUserIdHex = await computeEffectiveUserIdModeC(seed);
  const keypair = await deriveSigningKeypairModeC(seed);
  const transcript = buildSignedTranscript(
    'register-mode-c',
    effectiveUserIdHex,
    challenge,
  );
  const signature = await signTranscript(keypair.seed, transcript);
  return { effectiveUserIdHex, publicKey: keypair.publicKey, signature };
}

/** Sign-in proof (existing user, no OAuth re-token). Works for both modes:
 *  the server looks up the public key by effective_user_id and verifies.
 *  Pass the appropriate `modeB`/`modeC` derivation context. */
export async function buildSignInProof(args: {
  effectiveUserIdHex: string;
  signingSeed: Uint8Array;
  challenge: Uint8Array;
}): Promise<Uint8Array> {
  const { effectiveUserIdHex, signingSeed, challenge } = args;
  const transcript = buildSignedTranscript(
    'sign-in',
    effectiveUserIdHex,
    challenge,
  );
  return signTranscript(signingSeed, transcript);
}

// ============================================================================
// Master-KEK derivation (Argon2id) — matches canonical_kek_input.dart
// ============================================================================

/** Encode `u32_le(len(provider)) || provider || u32_le(len(sub)) || sub ||
 *  u32_le(len(NFC(seed))) || NFC(seed)` — the canonical Mode B KEK input.
 *  Length-prefixing defeats separator-injection ambiguity. */
export function buildModeBKekInput(
  provider: string,
  oauthSub: string,
  seed: string,
): Uint8Array {
  const enc = new TextEncoder();
  const providerBytes = enc.encode(provider);
  const subBytes = enc.encode(oauthSub);
  const seedBytes = enc.encode(seed.normalize('NFC'));
  const total =
    4 + providerBytes.length +
    4 + subBytes.length +
    4 + seedBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, providerBytes.length, true); o += 4;
  out.set(providerBytes, o); o += providerBytes.length;
  dv.setUint32(o, subBytes.length, true); o += 4;
  out.set(subBytes, o); o += subBytes.length;
  dv.setUint32(o, seedBytes.length, true); o += 4;
  out.set(seedBytes, o);
  return out;
}

/** Encode `u32_le(len(NFC(seed))) || NFC(seed)` — Mode C KEK input. */
export function buildModeCKekInput(seed: string): Uint8Array {
  const enc = new TextEncoder();
  const seedBytes = enc.encode(seed.normalize('NFC'));
  const out = new Uint8Array(4 + seedBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, seedBytes.length, true);
  out.set(seedBytes, 4);
  return out;
}

/** Derive the 32-byte AES-256 master KEK for a Mode B vault. Argon2id
 *  via WASM with context `fula-files-v2-mode-b` to match FxFiles. */
export async function deriveModeBKek(
  provider: string,
  oauthSub: string,
  password: string,
): Promise<Uint8Array> {
  await ensureWasm();
  const input = buildModeBKekInput(provider, oauthSub, password);
  return wasmDeriveKey('fula-files-v2-mode-b', input);
}

/** Derive the 32-byte AES-256 master KEK for a Mode C vault. Argon2id
 *  via WASM with context `fula-files-v2-mode-c` to match FxFiles. */
export async function deriveModeCKek(seed: string): Promise<Uint8Array> {
  await ensureWasm();
  const input = buildModeCKekInput(seed);
  return wasmDeriveKey('fula-files-v2-mode-c', input);
}
