/**
 * Hosted-MCP collab bundle — pure payload validation (HTTP-free).
 * ================================================================
 *
 * Validates the body of `POST /api/mcp/connections/bundle` (C1) before any DB
 * write. Kept as a pure function (no Express, no pg) so it can be unit-tested
 * directly — same convention as `mcpGrants.ts`'s `validateGrantsPayload` and
 * P11's `resolveMcpTtlSeconds`.
 *
 * A bundle carries the pointers + `wrapped_link_secret` a paired AI needs to act
 * on ONE collaboration group. `wrapped_link_secret` is CIPHERTEXT (a fula
 * ShareToken JSON sealed to the connection's X25519 pubkey) — opaque here and
 * safe at rest; the Worker unwraps it. We validate only the OUTER envelope the
 * store needs.
 *
 * `webui_base` is DELIBERATELY NOT stored: C2 derives it from its own request Host
 * (the service-authed caller) and the Worker re-validates https/loopback — so a
 * broad-population C1 client value never reaches the Worker's fetch. We still
 * accept + shape-check the field here for contract hygiene / a clear error, then
 * discard it.
 *
 * `connection_id` is OPTIONAL: when present it pins the exact connection row the
 * pairing just minted (removing the newest-row ambiguity); when absent the route
 * falls back to the newest non-revoked connection for (user, pubkey).
 */
import { normalizeMcpPubB64 } from './mcpTokens.js';
import { isCollabGroupId } from './collabTokens.js';

/** Field bounds (exported so tests + tooling pin them). */
export const BUNDLE_MANIFEST_BUCKET_MAX = 255;
export const BUNDLE_MANIFEST_KEY_MAX = 1024;
export const BUNDLE_WRAPPED_SECRET_MAX = 16384; // a sealed ShareToken JSON is a few KB
export const BUNDLE_WEBUI_BASE_MAX = 512;

/** Bucket identifiers: start alphanumeric, then [A-Za-z0-9._-]. */
const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True if `s` contains a C0 control char (U+0000..U+001F) or DEL (U+007F).
 * Written with char-code checks — NO control-char literals in source — so the
 * intent survives any editor/tooling that would strip a raw control byte.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** True if `s` contains a NUL byte (U+0000) — the only char rejected in ciphertext. */
function hasNul(s: string): boolean {
  return s.indexOf(String.fromCharCode(0)) !== -1;
}

/** Exactly what is persisted on the connection row (NO webui_base — see above). */
export interface ValidatedBundle {
  group_id: string;
  manifest_bucket: string;
  manifest_key: string;
  wrapped_link_secret: string;
}

export interface ValidatedBundlePayload {
  /** Normalized canonical standard-base64 of the 32-byte X25519 pubkey. */
  mcpPubB64: string;
  /** Optional explicit target connection row (UUID). */
  connectionId?: string;
  /** The bundle to store. */
  bundle: ValidatedBundle;
}

export type ValidateBundleResult =
  | { ok: true; value: ValidatedBundlePayload }
  | { ok: false; status: 400; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate the C1 body. Returns the normalized payload or a structured 400 with
 * the error the handler should send. FAIL-CLOSED / all-or-nothing: any malformed
 * field rejects the WHOLE request (no partial store).
 */
export function validateBundlePayload(body: unknown): ValidateBundleResult {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }

  const mcpPubB64 = normalizeMcpPubB64(body.mcp_pub_b64);
  if (!mcpPubB64) {
    return { ok: false, status: 400, error: 'mcp_pub_b64 must be base64 of a 32-byte X25519 public key' };
  }

  // group_id — a collab group UUID (shape only; the route additionally checks it
  // is AUTHORIZED on the connection's stored scope before storing).
  if (!isCollabGroupId(body.group_id)) {
    return { ok: false, status: 400, error: 'group_id must be a collab group UUID' };
  }
  const group_id = body.group_id as string;

  // manifest_bucket — a bucket identifier. Strict charset also rules out control
  // chars, whitespace, and path separators; reject ".." defensively.
  const manifest_bucket = body.manifest_bucket;
  if (
    typeof manifest_bucket !== 'string' ||
    manifest_bucket.length === 0 ||
    manifest_bucket.length > BUNDLE_MANIFEST_BUCKET_MAX ||
    !BUCKET_RE.test(manifest_bucket) ||
    manifest_bucket.includes('..')
  ) {
    return {
      ok: false,
      status: 400,
      error: `manifest_bucket must be 1-${BUNDLE_MANIFEST_BUCKET_MAX} chars of [A-Za-z0-9._-] starting alphanumeric (no "..")`,
    };
  }

  // manifest_key — an S3 object key (may contain "/") but never a control char,
  // a leading "/", or a ".." path segment.
  const manifest_key = body.manifest_key;
  if (
    typeof manifest_key !== 'string' ||
    manifest_key.length === 0 ||
    manifest_key.length > BUNDLE_MANIFEST_KEY_MAX ||
    hasControlChar(manifest_key) ||
    manifest_key.startsWith('/') ||
    manifest_key.split('/').includes('..')
  ) {
    return {
      ok: false,
      status: 400,
      error: `manifest_key must be 1-${BUNDLE_MANIFEST_KEY_MAX} chars with no control chars, no leading "/", and no ".." segment`,
    };
  }

  // wrapped_link_secret — opaque ciphertext (a sealed ShareToken JSON). Keep the
  // check permissive (it may be pretty-printed JSON with newlines/tabs): a
  // non-empty string within the cap, with no NUL byte. The Worker validates the
  // real structure when it unwraps.
  const wrapped_link_secret = body.wrapped_link_secret;
  if (
    typeof wrapped_link_secret !== 'string' ||
    wrapped_link_secret.length === 0 ||
    wrapped_link_secret.length > BUNDLE_WRAPPED_SECRET_MAX ||
    hasNul(wrapped_link_secret)
  ) {
    return {
      ok: false,
      status: 400,
      error: `wrapped_link_secret must be a non-empty string <= ${BUNDLE_WRAPPED_SECRET_MAX} chars with no NUL byte`,
    };
  }

  // webui_base — OPTIONAL. Accepted for contract hygiene and shape-checked (http/https
  // URL within the cap) so a broken value gets a clear error, but NOT stored: C2
  // derives the origin server-side to remove the SSRF surface.
  if (body.webui_base !== undefined && body.webui_base !== null) {
    if (typeof body.webui_base !== 'string' || body.webui_base.length === 0 || body.webui_base.length > BUNDLE_WEBUI_BASE_MAX) {
      return { ok: false, status: 400, error: `webui_base must be an http(s) URL <= ${BUNDLE_WEBUI_BASE_MAX} chars` };
    }
    let proto: string;
    try {
      proto = new URL(body.webui_base).protocol;
    } catch {
      return { ok: false, status: 400, error: 'webui_base must be a valid URL' };
    }
    if (proto !== 'http:' && proto !== 'https:') {
      return { ok: false, status: 400, error: 'webui_base must use http or https' };
    }
  }

  // connection_id — OPTIONAL explicit target row (UUID shape only; the route
  // verifies ownership + not-revoked + pubkey match).
  let connectionId: string | undefined;
  if (body.connection_id !== undefined && body.connection_id !== null) {
    if (!isCollabGroupId(body.connection_id)) {
      return { ok: false, status: 400, error: 'connection_id must be a UUID' };
    }
    connectionId = body.connection_id as string;
  }

  return {
    ok: true,
    value: {
      mcpPubB64,
      ...(connectionId !== undefined ? { connectionId } : {}),
      bundle: { group_id, manifest_bucket, manifest_key, wrapped_link_secret },
    },
  };
}
