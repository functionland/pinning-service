/**
 * MCP collaboration identity — the Worker's persistent X25519 keypair + the HPKE
 * link-secret UNWRAP seam (Method-2 identity). Port of the Rust
 * `crates/fula-mcp/src/identity.rs`, adapted for the multi-tenant hosted Worker
 * (the keypair secret lives in the Worker's OpenBao-wrapped D1 custody, not a
 * local file — see ./identityStore.ts).
 *
 * ## The "FULA-" identity string
 *
 * A share identity is its X25519 PUBLIC key, base64url-encoded with padding
 * stripped, prefixed `"FULA-"` (mirrors Dart `encodeFulaShareId` and the Rust
 * `encode_fula_id`). This is the string an owner addresses a collaboration grant
 * to. The Worker exposes it (and the raw base64 pubkey) via the connect flow so
 * FxFiles can wrap the group link secret to it.
 *
 * ## ⚠️ HPKE link-secret unwrap — the FLAGGED dependency (read the PR notes)
 *
 * The Rust local MCP recovers the link secret via
 * `fula_crypto::sharing::ShareRecipient::accept_share(token)`, where the wrapped
 * secret is a strict **v5 `ShareToken`** (it binds every token field + the
 * recipient public key into the DEK-wrap AAD). The pinned Worker WASM
 * (`@functionland/fula-client@0.6.17`) does NOT expose a function that returns the
 * recovered DEK from such a token: `acceptShare()` yields an OPAQUE `AcceptedShare`
 * handle (no `.dek`), and `testHpkeDecryptDek()` cannot reproduce the v5 AAD.
 *
 * So {@link recoverLinkSecret} supports the two shapes explicitly:
 *  - a **bare HPKE envelope** (`{ encapsulated_key, ciphertext }`, the
 *    `testHpkeEncryptDek` format) → unwrapped with {@link testHpkeDecryptDek}.
 *    This is the only shape the pinned WASM can unwrap today; if the hosted
 *    producer is defined as this (see PR notes), the Worker is fully functional.
 *  - a **v5 ShareToken** (`{ wrapped_key, version >= 5, … }`, the Rust/local-MCP
 *    contract) → a clear, actionable error: it needs a fula-client binding
 *    (e.g. `acceptShareDek(secretKeyBytes, tokenJson) -> Uint8Array`) that the
 *    pinned build lacks. This is the single named upstream dependency.
 *
 * NOTE: as of this PR there is NO producer that wraps a collab link secret to an
 * MCP pubkey on EITHER end (FxFiles still ships the old workspace model), so this
 * seam cannot be exercised end-to-end; it is unit-tested against the bare-envelope
 * shape and the v5 detection.
 */

import { derivePublicKeyFromSecret, testHpkeDecryptDek } from "../wasm.js";

/** The mandatory prefix on a FULA share identity string. */
const FULA_PREFIX = "FULA-";

/** Raised by the identity layer (unwrap failures, malformed inputs). */
export class IdentityError extends Error {
  constructor(
    readonly kind: "key" | "base64" | "share" | "unsupportedShareToken",
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

/** Derive the X25519 public key (32 bytes) from a 32-byte secret. */
export function publicKeyFromSecret(secret: Uint8Array): Uint8Array {
  if (secret.length !== 32) {
    throw new IdentityError("key", `X25519 secret must be 32 bytes, got ${secret.length}`);
  }
  return derivePublicKeyFromSecret(secret);
}

/**
 * Encode a 32-byte X25519 public key as a `"FULA-…"` share id (base64url,
 * padding stripped). Mirrors Dart `encodeFulaShareId` / Rust `encode_fula_id`.
 */
export function encodeFulaId(publicKey: Uint8Array): string {
  return FULA_PREFIX + base64UrlNoPad(publicKey);
}

/** The standard-base64 form of a public key (32 bytes), as FxFiles stores it. */
export function publicKeyB64(publicKey: Uint8Array): string {
  return base64Std(publicKey);
}

/**
 * Recover the wrapped 32-byte link secret with the Worker's X25519 SECRET key.
 *
 * See the module header: this supports the bare-HPKE-envelope shape (works with
 * the pinned WASM) and detects + rejects the v5-ShareToken shape (needs an
 * upstream fula-client binding). The recovered bytes are exactly the 32-byte link
 * secret used to derive the manifest key + every collab-file key.
 *
 * @throws {IdentityError} `unsupportedShareToken` for a v5 ShareToken (the binding
 *   is not in the pinned WASM); `share` if the bare-envelope HPKE decrypt fails
 *   (wrong recipient key / tampering).
 */
export function recoverLinkSecret(workerSecret: Uint8Array, wrappedLinkSecret: string): Uint8Array {
  if (workerSecret.length !== 32) {
    throw new IdentityError("key", `X25519 secret must be 32 bytes, got ${workerSecret.length}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(wrappedLinkSecret.trim()) as Record<string, unknown>;
  } catch (e) {
    throw new IdentityError("share", `wrapped_link_secret is not valid JSON: ${e instanceof Error ? e.message : "?"}`);
  }

  // A v5 ShareToken (the Rust / local-MCP contract) carries `wrapped_key` and a
  // numeric `version`. The pinned WASM cannot reproduce its recipient-bound AAD,
  // so surface the precise upstream dependency instead of silently failing.
  if ("wrapped_key" in parsed) {
    throw new IdentityError(
      "unsupportedShareToken",
      "wrapped_link_secret is a v5 ShareToken; recovering its DEK needs a fula-client " +
        "binding (e.g. acceptShareDek(secretKeyBytes, tokenJson)) that @functionland/fula-client@0.6.17 " +
        "does not expose. See the PR notes (HPKE-unwrap dependency).",
    );
  }

  // A bare HPKE envelope (`testHpkeEncryptDek` format): the only shape the pinned
  // WASM can unwrap today. `testHpkeDecryptDek` returns the 32-byte DEK.
  if ("encapsulated_key" in parsed && "ciphertext" in parsed) {
    try {
      const dek = testHpkeDecryptDek(workerSecret, wrappedLinkSecret);
      if (dek.length !== 32) {
        throw new IdentityError("share", `recovered link secret has unexpected length ${dek.length}`);
      }
      return dek;
    } catch (e) {
      if (e instanceof IdentityError) throw e;
      throw new IdentityError("share", `HPKE unwrap failed (wrong recipient key or tampered): ${e instanceof Error ? e.message : "?"}`);
    }
  }

  throw new IdentityError(
    "share",
    "wrapped_link_secret is neither a v5 ShareToken nor a bare HPKE envelope (unrecognized shape)",
  );
}

// ── base64 helpers ───────────────────────────────────────────────────────────

function base64UrlNoPad(bytes: Uint8Array): string {
  return base64Std(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Std(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * Decode a `"FULA-…"` share id (or a bare base64 / base64url key) back to the
 * public-key bytes. Mirrors Dart `decodeFulaShareId` / Rust `decode_fula_id`.
 */
export function decodeFulaId(input: string): Uint8Array {
  const trimmed = input.trim();
  let body = trimmed;
  if (trimmed.length >= FULA_PREFIX.length && trimmed.slice(0, FULA_PREFIX.length).toUpperCase() === FULA_PREFIX) {
    body = trimmed.slice(FULA_PREFIX.length);
  }
  body = body.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  while (body.length % 4 !== 0) body += "=";
  try {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    throw new IdentityError("base64", `FULA id base64 decode failed: ${e instanceof Error ? e.message : "?"}`);
  }
}
