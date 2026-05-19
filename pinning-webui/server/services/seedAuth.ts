/**
 * Seed-derived authentication for FxFiles Mode B / Mode C.
 *
 * Implements the issuer side of the "seed IS the user" design (audit
 * F-A1 / F-A3 redesign, 2026-05-18). The seed never leaves the client
 * device. The client derives a 16-byte `effective_user_id` and an
 * Ed25519 signing keypair from the seed, and proves possession of the
 * private key via a challenge-response handshake before this service
 * mints a JWT with `sub = effective_user_id_hex`.
 *
 * The matching client-side primitives live in fula-crypto
 * (`crates/fula-crypto/src/effective_user_id.rs`) and are exposed via
 * fula-flutter FFI. See:
 *  - https://github.com/functionland/fula-api/commit/7fa2f32
 *  - https://github.com/functionland/fula-api/issues/14
 *
 * NOTE: this service does NOT recompute the BLAKE3 derivation of
 * `effective_user_id` — it has no seed and could not check it.
 * The contract is "whoever can sign with the matching public key
 * IS the user." The 128-bit hash space makes pre-emptive squatting
 * infeasible.
 */

import crypto from 'crypto';
import type { PoolClient } from 'pg';

/** Constant-time-comparable base64 → Buffer with strict length check. */
function b64ToBufStrict(s: string, expectedBytes: number, fieldName: string): Buffer {
  const buf = Buffer.from(s, 'base64');
  if (buf.length !== expectedBytes) {
    throw new ValidationError(
      `${fieldName} must decode to exactly ${expectedBytes} bytes; got ${buf.length}`
    );
  }
  return buf;
}

/** Regex for a 32-char lowercase hex string (= 16 bytes hex-encoded). */
const HEX32_RE = /^[0-9a-f]{32}$/;

/** Allowed provider tags for Mode B. Mirror the canonical strings the
 *  client uses when computing `effective_user_id_mode_b`. */
const ALLOWED_PROVIDERS = new Set(['google', 'apple']);

/** TTL for an issued challenge nonce, in milliseconds. */
const CHALLENGE_TTL_MS = 60_000;

/** Length of the random nonce we hand to clients. 32 bytes = 256 bits. */
const CHALLENGE_LEN = 32;

/** Length of an Ed25519 public key in bytes. */
const ED25519_PK_LEN = 32;

/** Length of an Ed25519 signature in bytes. */
const ED25519_SIG_LEN = 64;

// ============================================================================
// Errors
// ============================================================================

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class PublicKeyMismatchError extends Error {
  constructor() {
    super(
      'effective_user_id is already registered with a different public key'
    );
    this.name = 'PublicKeyMismatchError';
  }
}

export class UserNotFoundError extends Error {
  constructor() {
    super('no such effective_user_id');
    this.name = 'UserNotFoundError';
  }
}

export class ChallengeNotFoundError extends Error {
  constructor() {
    super('challenge missing or expired');
    this.name = 'ChallengeNotFoundError';
  }
}

export class SignatureInvalidError extends Error {
  constructor() {
    super('challenge signature did not verify');
    this.name = 'SignatureInvalidError';
  }
}

// ============================================================================
// Input validation
// ============================================================================

export function validateEffectiveUserIdHex(s: unknown): string {
  if (typeof s !== 'string') {
    throw new ValidationError('effective_user_id_hex must be a string');
  }
  if (!HEX32_RE.test(s)) {
    throw new ValidationError(
      'effective_user_id_hex must be exactly 32 lowercase hex characters'
    );
  }
  return s;
}

export function validateProvider(s: unknown): 'google' | 'apple' {
  if (typeof s !== 'string' || !ALLOWED_PROVIDERS.has(s)) {
    throw new ValidationError(
      `provider must be one of: ${Array.from(ALLOWED_PROVIDERS).join(', ')}`
    );
  }
  return s as 'google' | 'apple';
}

export function decodePublicKey(b64: unknown): Buffer {
  if (typeof b64 !== 'string') {
    throw new ValidationError('public_key_b64 must be a base64 string');
  }
  return b64ToBufStrict(b64, ED25519_PK_LEN, 'public_key_b64');
}

export function decodeChallenge(b64: unknown): Buffer {
  if (typeof b64 !== 'string') {
    throw new ValidationError('challenge_b64 must be a base64 string');
  }
  return b64ToBufStrict(b64, CHALLENGE_LEN, 'challenge_b64');
}

export function decodeSignature(b64: unknown): Buffer {
  if (typeof b64 !== 'string') {
    throw new ValidationError('signature_b64 must be a base64 string');
  }
  return b64ToBufStrict(b64, ED25519_SIG_LEN, 'signature_b64');
}

// ============================================================================
// Ed25519 verification
// ============================================================================

/** ASN.1/DER SPKI prefix for an Ed25519 public key. The 12 prefix
 *  bytes plus the 32 raw public key bytes form a valid SPKI DER
 *  encoding that Node's `crypto.createPublicKey` accepts. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519PublicKeyFromRaw(raw32: Buffer): crypto.KeyObject {
  if (raw32.length !== ED25519_PK_LEN) {
    throw new Error(`Ed25519 public key must be ${ED25519_PK_LEN} bytes`);
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify an Ed25519 signature using a raw 32-byte public key.
 * Returns true on success, false on signature failure. Throws only
 * on malformed key material.
 */
export function verifyEd25519(
  rawPublicKey: Buffer,
  message: Buffer,
  signature: Buffer
): boolean {
  return crypto.verify(
    null,
    message,
    ed25519PublicKeyFromRaw(rawPublicKey),
    signature
  );
}

// ============================================================================
// Signed-transcript construction (cross-replay defense)
// ============================================================================

/** Purpose tags. A signature issued for one purpose MUST NOT verify
 *  for another — the purpose tag is in the signed transcript. */
export type Purpose =
  | 'register-mode-b'
  | 'register-mode-c'
  | 'sign-in';

const DOMAIN = Buffer.from('fula.seed-auth.v1\0');

/**
 * Build the deterministic byte sequence the client signs with its
 * seed-derived Ed25519 private key. Includes domain, purpose, and
 * `effective_user_id` so a signature issued for sign-in cannot be
 * replayed against register, and a signature for one user cannot be
 * replayed for another.
 */
export function buildSignedTranscript(
  purpose: Purpose,
  effectiveUserIdHex: string,
  challenge: Buffer
): Buffer {
  // Layout (length-prefixed wherever ambiguous):
  //   DOMAIN || NUL ||
  //   purpose_bytes || NUL ||
  //   effective_user_id_hex_bytes || NUL ||
  //   challenge_bytes
  const purposeBytes = Buffer.from(purpose, 'utf8');
  const uidBytes = Buffer.from(effectiveUserIdHex, 'ascii');
  return Buffer.concat([
    DOMAIN,
    purposeBytes,
    Buffer.from([0]),
    uidBytes,
    Buffer.from([0]),
    challenge,
  ]);
}

// ============================================================================
// In-memory challenge store
// ============================================================================
//
// Single-process server today (BIND_HOST=127.0.0.1 by default). If
// the deployment is ever scaled horizontally, swap this for Redis.
// Lazy expiry on lookup keeps the implementation tiny; a small
// periodic sweep prevents the map from growing unbounded under spam.

interface ChallengeEntry {
  challenge: Buffer;
  expiresAt: number;
  purpose: Purpose;
}

export interface ChallengeStore {
  put(effectiveUserIdHex: string, entry: ChallengeEntry): void;
  takeIfValid(
    effectiveUserIdHex: string,
    expectedPurpose: Purpose
  ): ChallengeEntry | null;
  size(): number;
  clearExpired(now?: number): number;
}

export function createInMemoryChallengeStore(): ChallengeStore {
  const map = new Map<string, ChallengeEntry>();
  return {
    put(uid, entry) {
      map.set(uid, entry);
    },
    takeIfValid(uid, expectedPurpose) {
      const entry = map.get(uid);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        map.delete(uid);
        return null;
      }
      if (entry.purpose !== expectedPurpose) {
        // Purpose mismatch is a programming error or attempted replay.
        // Don't consume the challenge — let the caller see null and
        // surface the right error.
        return null;
      }
      // Single-use: consume on successful take.
      map.delete(uid);
      return entry;
    },
    size() {
      return map.size;
    },
    clearExpired(now = Date.now()) {
      let removed = 0;
      for (const [uid, entry] of map.entries()) {
        if (entry.expiresAt <= now) {
          map.delete(uid);
          removed++;
        }
      }
      return removed;
    },
  };
}

/** Issue a fresh random challenge for the given user-id and purpose,
 *  store it with TTL, return the bytes the client must sign. */
export function issueChallenge(
  store: ChallengeStore,
  effectiveUserIdHex: string,
  purpose: Purpose
): Buffer {
  const challenge = crypto.randomBytes(CHALLENGE_LEN);
  store.put(effectiveUserIdHex, {
    challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    purpose,
  });
  return challenge;
}

// ============================================================================
// Persistence (seed_users table)
// ============================================================================

export interface SeedUserRow {
  effective_user_id: string;
  mode: 'B' | 'C';
  public_key: Buffer;
  oauth_sub: string | null;
  provider: 'google' | 'apple' | null;
  registered_at: Date;
  last_used_at: Date | null;
}

/** Look up a seed-user row. Returns null if absent. */
export async function getSeedUser(
  client: PoolClient | { query: any },
  effectiveUserIdHex: string
): Promise<SeedUserRow | null> {
  const res = await client.query(
    `SELECT effective_user_id, mode, public_key, oauth_sub, provider, registered_at, last_used_at
       FROM seed_users
      WHERE effective_user_id = $1`,
    [effectiveUserIdHex]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0] as SeedUserRow;
}

/** Update `last_used_at = NOW()` for a successful sign-in. Errors are
 *  swallowed — this is metric-only state. */
export async function touchSeedUserLastUsed(
  client: PoolClient | { query: any },
  effectiveUserIdHex: string
): Promise<void> {
  try {
    await client.query(
      `UPDATE seed_users SET last_used_at = NOW() WHERE effective_user_id = $1`,
      [effectiveUserIdHex]
    );
  } catch (e) {
    console.warn('[seedAuth] last_used_at update failed (continuing):', e);
  }
}

/**
 * Atomically register a new seed-user. Behavior on conflict
 * (`effective_user_id` already exists):
 *  - If the stored public_key matches the supplied one → idempotent
 *    re-registration, returns the existing row (no error).
 *  - If the stored public_key differs → throws `PublicKeyMismatchError`
 *    (squatting / takeover attempt).
 *
 * Must be called inside a transaction by the caller; the caller is
 * also responsible for creating the matching `webui_users` row in the
 * same transaction so the rest of the app can find the user.
 */
export async function insertOrAssertSeedUser(
  txClient: PoolClient,
  args: {
    effectiveUserIdHex: string;
    mode: 'B' | 'C';
    publicKey: Buffer;
    oauthSub: string | null;
    provider: 'google' | 'apple' | null;
  }
): Promise<{ row: SeedUserRow; created: boolean }> {
  // Try insert; on conflict, do nothing and return the existing row
  // for inspection.
  const insertRes = await txClient.query(
    `INSERT INTO seed_users
       (effective_user_id, mode, public_key, oauth_sub, provider, registered_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (effective_user_id) DO NOTHING
     RETURNING effective_user_id, mode, public_key, oauth_sub, provider,
               registered_at, last_used_at`,
    [
      args.effectiveUserIdHex,
      args.mode,
      args.publicKey,
      args.oauthSub,
      args.provider,
    ]
  );
  if (insertRes.rows.length === 1) {
    return { row: insertRes.rows[0] as SeedUserRow, created: true };
  }
  // Conflict — fetch the existing row and check the public_key.
  const existing = await getSeedUser(txClient, args.effectiveUserIdHex);
  if (!existing) {
    // Shouldn't happen — race between our INSERT and a DELETE? Reject.
    throw new Error(
      'seed_users row vanished between INSERT and SELECT — transaction abort'
    );
  }
  if (!constantTimeEqual(existing.public_key, args.publicKey)) {
    throw new PublicKeyMismatchError();
  }
  return { row: existing, created: false };
}

/** Constant-time byte comparison. */
function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
