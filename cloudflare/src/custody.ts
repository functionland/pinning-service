/**
 * Capability custody — envelope encryption of the per-user SCOPED capability (H2).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * THE GUARANTEE (the bar this phase must hit)
 * ───────────────────────────────────────────
 * A stolen D1 dump — even together with the Worker's own config/secrets — must
 * decrypt to NOTHING when there is no LIVE OpenBao to unwrap the per-record DEK.
 * We achieve that with classic envelope encryption where the KEK lives in a
 * different trust domain (OpenBao, see ./openbao.ts):
 *
 *   sealCapability(cap):
 *     DEK          = 32 random bytes                       (per record; ephemeral)
 *     ciphertext   = XChaCha20-Poly1305(DEK, nonce, AAD, plaintext)
 *     wrapped_dek  = OpenBao transit-encrypt(DEK)          (opaque "vault:v1:…")
 *     persist { capability_ciphertext = nonce‖ciphertext‖tag, wrapped_dek, … }
 *     — the raw DEK is zeroized and NEVER persisted.
 *
 *   openCapability(user_id):
 *     load row → DEK = OpenBao transit-decrypt(wrapped_dek) → decrypt blob → cap
 *     — requires a live OpenBao; with the KEK unreachable this FAILS CLOSED.
 *
 * DEK CIPHER — XChaCha20-Poly1305 (@noble/ciphers), justification:
 *   • The Workers runtime's WebCrypto has AES-GCM but NOT XChaCha; @noble/ciphers
 *     is a small, audited, pure-JS, zero-dependency implementation that runs in
 *     a V8 isolate. AES-256-GCM (WebCrypto) would also be acceptable, but
 *     XChaCha's 24-byte (192-bit) nonce makes a freshly RANDOM nonce per record
 *     collision-safe by construction — no nonce counter/state to manage and no
 *     birthday-bound worry at scale, which is the right default for a store that
 *     re-seals on every update. (AES-GCM's 96-bit random nonce creeps toward a
 *     birthday bound far sooner.) Both give AEAD with Associated Data; we use the
 *     AAD to bind the row's identity (below).
 *
 * AAD — binds the ciphertext to the ROW IDENTITY (advisor-critical fix)
 *   AAD = domain-tag ‖ user_id ‖ record_id ‖ dek_version ‖ alg, each field
 *   length-prefixed (a deterministic, unambiguous binary encoding — NOT ad-hoc
 *   JSON). Binding `user_id` (not just `record_id`) is REQUIRED: the PK is
 *   user_id, so an attacker with D1 write who copies another user's ciphertext +
 *   wrapped_dek into a victim's row would otherwise decrypt successfully (cross-
 *   tenant escalation). With user_id in the AAD, that swap fails the Poly1305 tag.
 *   Binding `alg`/`dek_version` blocks an algorithm/format downgrade forge.
 *   DEFENSE IN DEPTH: user_id is ALSO embedded in the plaintext and re-checked
 *   after decryption, so even an AAD-construction bug cannot silently return
 *   another user's capability.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { clean } from "@noble/ciphers/utils.js";
import { OpenBaoTransit } from "./openbao.js";

/** The current envelope format version. Bound into the AAD. */
export const DEK_VERSION = 1;
/** The AEAD identifier persisted in `alg` and bound into the AAD. */
export const ALG = "xchacha20poly1305";
/** A fixed domain-separation tag so this AAD can never collide with another use. */
const AAD_DOMAIN = "fula-mcp/capability/v1";
const NONCE_LEN = 24; // XChaCha20-Poly1305 nonce length.

/**
 * The SCOPED capability. NOTE every field is a secret EXCEPT `endpoint`:
 *   • workspace_secret — 32 bytes (base64) that unlock ONLY the AI-workspace
 *     forest. It is one-way-derived from the master KEK and CANNOT unlock the
 *     user's real files. NOT the KEK.
 *   • mcp_secret       — the X25519 connection secret (the Layer-1 connection).
 *   • refresh_token    — the Layer-1 connection refresh credential (toxic: it
 *     re-mints gateway tokens; minimized + revocable upstream).
 *   • refresh_url      — where to refresh (operational, but kept inside the blob).
 *   • endpoint         — non-secret storage endpoint (also stored as a column for
 *     operational queries; see the schema).
 */
export interface CapabilityData {
  workspace_secret: string;
  mcp_secret: string;
  refresh_token: string;
  refresh_url: string;
  endpoint: string;
}

/**
 * An OPENED capability held in memory for the duration of a session. It is NEVER
 * persisted and NEVER logged. `dispose()` best-effort zeroizes the backing
 * plaintext bytes (JS gives no hard guarantee, but we null the reference and wipe
 * the decrypted buffer we control).
 */
export class Capability {
  private disposed = false;
  private constructor(
    private data: CapabilityData | null,
    /** The decrypted plaintext bytes (wiped on dispose). */
    private plaintext: Uint8Array | null,
  ) {}

  /** @internal — constructed only by openCapability after verification. */
  static __fromVerified(data: CapabilityData, plaintext: Uint8Array): Capability {
    return new Capability(data, plaintext);
  }

  /** Access the capability fields. Throws if already disposed. */
  get(): CapabilityData {
    if (this.disposed || !this.data) {
      throw new Error("Capability has been disposed");
    }
    return this.data;
  }

  /** Best-effort zeroize. Idempotent. */
  dispose(): void {
    if (this.plaintext) clean(this.plaintext);
    this.plaintext = null;
    this.data = null;
    this.disposed = true;
  }
}

/** A row as persisted in D1 (mirrors schema.sql). */
interface CapabilityRow {
  user_id: string;
  record_id: string;
  capability_ciphertext: ArrayBuffer | Uint8Array;
  wrapped_dek: string;
  dek_version: number;
  alg: string;
  endpoint: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** Minimal D1 surface we use (so the module is easy to unit-test). */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

// ── AAD construction ─────────────────────────────────────────────────────────
// Deterministic length-prefixed concatenation of the binding fields. Each field
// is encoded as: uint32 big-endian length ‖ utf-8 bytes. This is unambiguous
// (no field boundary can be shifted into another), unlike naive concatenation.
function buildAad(parts: {
  userId: string;
  recordId: string;
  dekVersion: number;
  alg: string;
}): Uint8Array {
  const enc = new TextEncoder();
  const fields = [
    enc.encode(AAD_DOMAIN),
    enc.encode(parts.userId),
    enc.encode(parts.recordId),
    enc.encode(String(parts.dekVersion)),
    enc.encode(parts.alg),
  ];
  let total = 0;
  for (const f of fields) total += 4 + f.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const f of fields) {
    view.setUint32(off, f.length, false); // big-endian length prefix
    off += 4;
    out.set(f, off);
    off += f.length;
  }
  return out;
}

/**
 * Seal a capability for `userId`: fresh DEK → AEAD-encrypt (AAD-bound) → wrap the
 * DEK via OpenBao → persist. Re-seals overwrite the user's row with a FRESH
 * record_id, DEK and nonce (so an older D1 backup of that row becomes useless
 * once the row is replaced). Returns the new record_id.
 *
 * The capability secrets exist on the Worker only transiently here (in memory);
 * after this returns, only the OpenBao-wrapped ciphertext is at rest.
 */
export async function sealCapability(
  db: D1Like,
  bao: OpenBaoTransit,
  userId: string,
  cap: CapabilityData,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(userId)) {
    // user_id is SHA-256 hex; reject anything else (defensive — the caller
    // derives it from a verified token, but never trust the shape implicitly).
    throw new Error("sealCapability: invalid user_id");
  }
  const recordId = crypto.randomUUID();
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));

  // Embed user_id INSIDE the plaintext too (defense in depth — verified on open).
  const sealed = { v: DEK_VERSION, user_id: userId, cap };
  const plaintext = new TextEncoder().encode(JSON.stringify(sealed));

  const aad = buildAad({ userId, recordId, dekVersion: DEK_VERSION, alg: ALG });
  let ciphertext: Uint8Array;
  try {
    const aead = xchacha20poly1305(dek, nonce, aad);
    const ct = aead.encrypt(plaintext); // ct includes the Poly1305 tag
    // Stored blob layout: nonce ‖ ciphertext‖tag.
    ciphertext = new Uint8Array(nonce.length + ct.length);
    ciphertext.set(nonce, 0);
    ciphertext.set(ct, nonce.length);
  } finally {
    clean(plaintext); // wipe the plaintext we control
  }

  // Wrap the DEK via OpenBao (the KEK never touches the Worker). On ANY failure
  // we throw BEFORE persisting — never store an unwrappable/raw key.
  let wrappedDek: string;
  try {
    wrappedDek = await bao.wrapDek(dek);
  } finally {
    clean(dek); // wipe the raw DEK regardless of outcome
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // UPSERT: one row per user. Overwriting rotates record_id + DEK + nonce.
  await db
    .prepare(
      `INSERT INTO mcp_capabilities
         (user_id, record_id, capability_ciphertext, wrapped_dek, dek_version, alg, endpoint, created_at, last_used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         record_id = excluded.record_id,
         capability_ciphertext = excluded.capability_ciphertext,
         wrapped_dek = excluded.wrapped_dek,
         dek_version = excluded.dek_version,
         alg = excluded.alg,
         endpoint = excluded.endpoint,
         created_at = excluded.created_at,
         last_used_at = NULL`,
    )
    .bind(
      userId,
      recordId,
      ciphertext,
      wrappedDek,
      DEK_VERSION,
      ALG,
      cap.endpoint ?? null,
      nowSec,
    )
    .run();

  return recordId;
}

/**
 * Open the capability for `userId`: load the row → unwrap the DEK via OpenBao →
 * AEAD-decrypt (AAD rebuilt from the ROW's own fields) → verify the embedded
 * user_id matches → return an in-memory Capability.
 *
 * FAILS CLOSED: if OpenBao is unreachable (no live KEK), if the tag does not
 * verify (tampered/swapped row), or if the embedded user_id mismatches, this
 * THROWS and yields no plaintext. Returns null only when the user simply has no
 * custodied capability (no row) — distinct from a decryption failure.
 */
export async function openCapability(
  db: D1Like,
  bao: OpenBaoTransit,
  userId: string,
): Promise<Capability | null> {
  const row = await db
    .prepare(
      `SELECT user_id, record_id, capability_ciphertext, wrapped_dek, dek_version, alg, endpoint, created_at, last_used_at
         FROM mcp_capabilities WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<CapabilityRow>();
  if (!row) return null;

  // Only the alg we understand. (dek_version/alg come from the DB and are
  // attacker-influenceable if D1 is tampered — but they are ALSO bound into the
  // AAD, so a mismatch with what was sealed makes the tag fail below. We still
  // reject an unknown alg up front to avoid feeding junk to the cipher.)
  if (row.alg !== ALG) {
    throw new Error("openCapability: unsupported alg");
  }

  const blob =
    row.capability_ciphertext instanceof Uint8Array
      ? row.capability_ciphertext
      : new Uint8Array(row.capability_ciphertext);
  if (blob.length <= NONCE_LEN + 16) {
    throw new Error("openCapability: ciphertext too short");
  }
  const nonce = blob.slice(0, NONCE_LEN);
  const ct = blob.slice(NONCE_LEN);

  // Unwrap the DEK — the step that REQUIRES a live OpenBao. Throws (fail-closed)
  // if OpenBao is down/unreachable: this is the "DB-dump-yields-nothing" gate.
  const dek = await bao.unwrapDek(row.wrapped_dek);

  // Rebuild the AAD from the ROW's identity fields. A row swapped under another
  // user_id rebuilds a DIFFERENT AAD → the Poly1305 tag fails → decrypt throws.
  const aad = buildAad({
    userId: row.user_id,
    recordId: row.record_id,
    dekVersion: row.dek_version,
    alg: row.alg,
  });

  let plaintext: Uint8Array;
  try {
    const aead = xchacha20poly1305(dek, nonce, aad);
    plaintext = aead.decrypt(ct); // throws if the tag does not verify
  } catch {
    clean(dek);
    // Coarse error — never leak ciphertext/key material.
    throw new Error("openCapability: decryption failed (tag mismatch)");
  } finally {
    clean(dek);
  }

  // Parse + verify the embedded user_id (defense in depth vs cross-row swap).
  let parsed: { v?: number; user_id?: string; cap?: CapabilityData };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    clean(plaintext);
    throw new Error("openCapability: malformed plaintext");
  }
  if (parsed.user_id !== userId || !parsed.cap) {
    clean(plaintext);
    throw new Error("openCapability: identity binding mismatch");
  }

  return Capability.__fromVerified(parsed.cap, plaintext);
}
