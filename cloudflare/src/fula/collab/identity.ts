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
 * ## HPKE link-secret unwrap (Method-2) — wired to the 0.6.19 recipient binding
 *
 * The Rust local MCP recovers the link secret via
 * `fula_crypto::sharing::ShareRecipient::accept_share(token)`, where the wrapped
 * secret is a strict **v5 `ShareToken`** (it binds every token field + the
 * recipient public key into the DEK-wrap AAD). `@functionland/fula-client@0.6.19`
 * now exposes the consumer binding `unwrapSecretForRecipient(secretKeyBytes,
 * tokenJson) -> Uint8Array` (the sibling of FxFiles' `wrapSecretForRecipient`), so
 * {@link recoverLinkSecret} unwraps the production v5 ShareToken directly.
 *
 * {@link recoverLinkSecret} handles two shapes:
 *  - a **v5 ShareToken** (`{ wrapped_key, version >= 5, … }`, the Rust/local-MCP +
 *    FxFiles contract) → the PRODUCTION path, via `unwrapSecretForRecipient`.
 *  - a **bare HPKE envelope** (`{ encapsulated_key, ciphertext }`, the
 *    `testHpkeEncryptDek` format) → a GATED TEST affordance (`allowBareEnvelope`),
 *    unwrapped with {@link testHpkeDecryptDek}. It lacks v5's recipient/group/
 *    expiry AAD binding and is DISABLED on the live path.
 */

import { derivePublicKeyFromSecret, testHpkeDecryptDek, unwrapSecretForRecipient } from "../wasm.js";

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

/** Options for {@link recoverLinkSecret}. */
export interface RecoverOptions {
  /**
   * Permit the bare-HPKE-envelope shape (the `testHpkeEncryptDek` format).
   * Default FALSE. Production requires the real v5 ShareToken contract (which
   * needs a fula-client DEK binding the pinned WASM lacks), so the bare path is
   * an interim/TEST affordance ONLY — it carries NONE of v5's recipient/group/
   * expiry AAD binding and must never silently become the production unwrap.
   * Gating it keeps the live path strictly v5 (fail-closed until the binding
   * lands) while letting the unit tests exercise the round-trip.
   */
  allowBareEnvelope?: boolean;
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
 * @throws {IdentityError} `share` if the v5 ShareToken unwrap fails (wrong recipient
 *   key, expired, or tampered) or the bare-envelope HPKE decrypt fails;
 *   `unsupportedShareToken` for a bare envelope when `allowBareEnvelope` is not set
 *   (production is fail-closed v5-only); `key` if the secret is not 32 bytes.
 */
export function recoverLinkSecret(
  workerSecret: Uint8Array,
  wrappedLinkSecret: string,
  opts: RecoverOptions = {},
): Uint8Array {
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
  // numeric `version`. Recover the wrapped link secret with the 0.6.19 recipient
  // binding (`unwrapSecretForRecipient` — the consumer half of FxFiles'
  // `wrapSecretForRecipient`). `accept_share` enforces strict-v5, the expiry, and
  // the recipient-pubkey AAD binding, so a wrong key / expired / tampered token all
  // fail closed. This is the production path (the bare-envelope branch below is a
  // gated TEST affordance only).
  if ("wrapped_key" in parsed) {
    try {
      const secret = unwrapSecretForRecipient(workerSecret, wrappedLinkSecret);
      if (secret.length !== 32) {
        throw new IdentityError("share", `recovered link secret has unexpected length ${secret.length}`);
      }
      return secret;
    } catch (e) {
      if (e instanceof IdentityError) throw e;
      throw new IdentityError(
        "share",
        `v5 ShareToken unwrap failed (wrong recipient key, expired, or tampered): ${e instanceof Error ? e.message : "?"}`,
      );
    }
  }

  // A bare HPKE envelope (`testHpkeEncryptDek` format): the only shape the pinned
  // WASM can unwrap today. It is GATED — the live path must not silently accept a
  // shape that drops v5's recipient/group/expiry AAD binding (it is fail-closed
  // v5-only until the binding lands; only tests opt in via `allowBareEnvelope`).
  if ("encapsulated_key" in parsed && "ciphertext" in parsed) {
    if (!opts.allowBareEnvelope) {
      throw new IdentityError(
        "unsupportedShareToken",
        "wrapped_link_secret is a bare HPKE envelope; this shape is disabled on the live path " +
          "(it lacks v5's recipient/group/expiry AAD binding). The production contract is a v5 " +
          "ShareToken pending a fula-client DEK binding — see the PR notes.",
      );
    }
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
