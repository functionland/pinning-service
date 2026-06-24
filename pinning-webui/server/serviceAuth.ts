import crypto from 'crypto';

/**
 * HMAC service-auth — the TS verifier for the co-located Fula S3 gateway (B2).
 *
 * For AI/MCP writes the gateway holds a gateway-scoped JWT (token_use=mcp_s3),
 * which is NOT a login session, so the normal storage/quota auth rejects it.
 * Instead the gateway asserts the user via a short-lived HMAC over (user_id, exp)
 * in the `X-Fula-Service-Auth` header. This verifier mirrors the Go one in
 * `pinning-service/openapi/go/service_auth.go` and the Rust minter in
 * `fula-blockstore/src/service_auth.rs`; the wire format is locked across all
 * three by a shared test vector (see serviceAuth.test.ts).
 *
 * Format: `v1.<b64url(user_id)>.<exp_unix>.<b64url(HMAC_SHA256(secret, "v1."+uidb64+"."+exp))>`
 */
export const SERVICE_AUTH_HEADER = 'x-fula-service-auth';

/** Env var holding the shared secret (same value the gateway uses). */
export const SERVICE_SECRET_ENV = 'FULA_PIN_SERVICE_SECRET';

/**
 * Verify an `X-Fula-Service-Auth` value and return the asserted user_id, or
 * `null` if absent/invalid/expired. FAIL-CLOSED: when a PRESENT header returns
 * null, callers MUST reject — never fall back to session auth. An empty/`disabled`
 * secret disables the path (returns null for any header).
 */
export function verifyServiceAuth(raw: string | undefined, secret: string): string | null {
  if (!raw) return null;
  if (!secret || secret === 'disabled') return null;

  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, uidB64, expStr, sigB64] = parts;

  const exp = Number(expStr);
  if (!Number.isInteger(exp) || Math.floor(Date.now() / 1000) >= exp) return null;

  const want = crypto.createHmac('sha256', secret).update(`v1.${uidB64}.${expStr}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !crypto.timingSafeEqual(want, got)) return null;

  try {
    const uid = Buffer.from(uidB64, 'base64url').toString('utf8');
    return uid.length > 0 ? uid : null;
  } catch {
    return null;
  }
}
