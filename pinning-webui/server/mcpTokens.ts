/**
 * Phase 11 — Scoped MCP-JWT issuer
 * ================================
 *
 * This module defines and implements the **scoped MCP token** minted by the
 * pinning-webui for a user's paired MCP (Model Context Protocol) agent. The
 * agent presents this JWT to the Fula S3 gateway; the gateway (Phase 12, "P12")
 * PARSES and ENFORCES the claims below, so the claim shape here is a
 * cross-service CONTRACT. Treat changes to it as breaking and version them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT (P12 must parse + enforce this byte-for-byte)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Signing: HS256 with the shared `JWT_SECRET` (same secret as the existing
 * storage JWTs). JOSE header carries an explicit media type so a gateway can
 * reject the wrong token kind before touching the payload:
 *
 *   header: { "alg": "HS256", "typ": "mcp-s3+jwt" }
 *
 * Payload (decoded example):
 *
 *   {
 *     "iss": "pinning-webui",
 *     "aud": "fula-s3-gateway",
 *     "sub": "<64-hex user_id>",          // SHA-256(email) — same as storage JWT
 *     "jti": "<uuid v4>",                 // unique per token; revocation key
 *     "iat": 1718900000,
 *     "nbf": 1718900000,
 *     "exp": 1718903600,                  // short; default +3600s, configurable
 *     "token_use": "mcp_s3",              // discriminator (see below)
 *     "mcp": {
 *       "v": 1,                           // MAJOR schema version
 *       "scopes": [
 *         {
 *           "bucket": "fula-ai-workspace",
 *           "prefix": "ai/",                // CONSTANT — the AI-workspace key
 *                                           // namespace the MCP writes under
 *           "perms": ["read", "write", "list"]
 *         }
 *       ]
 *     }
 *   }
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT P12 (the gateway) MUST CHECK — defense in depth, all required
 * ────────────────────────────────────────────────────────────────────────────
 *  1. header.alg  === "HS256"         (do NOT accept "none" or asymmetric algs)
 *  2. header.typ  === "mcp-s3+jwt"
 *  3. signature verifies under the shared JWT_SECRET
 *  4. iss         === "pinning-webui"
 *  5. aud         includes "fula-s3-gateway"
 *  6. token_use   === "mcp_s3"
 *  7. exp present AND not expired (allow <=120s clock skew); reject if
 *       (exp - iat) > the gateway's configured MAX TTL — caps minting bugs.
 *  8. nbf, if present, not in the future (allow skew).
 *  9. mcp.v       === 1   (REJECT unknown major versions — fail closed)
 * 10. mcp.scopes is a non-empty array; for v1 exactly one scope entry.
 * 11. For each scope: bucket is a known AI-workspace bucket, perms ⊆
 *       {"read","write","list"}, and prefix === "ai/" EXACTLY (segment-boundary,
 *       i.e. the literal constant). `ai/` is the AI-workspace key namespace the
 *       MCP actually writes under (keys are `ai/<category>/...` in
 *       `fula-ai-workspace`; the gateway stores keys verbatim), so this prefix
 *       must be the constant for real MCP ops to pass. CROSS-USER ISOLATION
 *       does NOT come from this prefix — it comes from the gateway opening
 *       buckets per `(hashed_user_id, bucket)` plus the JWT `sub`. P12 must
 *       enforce `prefix === "ai/"`; it does NOT re-derive a per-user prefix.
 * 12. jti present AND not in the revocation set (see revocation section).
 *
 * Token-confusion guard: the existing long-lived storage JWTs share JWT_SECRET
 * but have `scope: "storage:read storage:write"`, NO `exp`, NO `typ`, NO
 * `token_use`, NO `mcp`. A gateway that enforces (2)+(6)+(7)+(9) cannot mistake
 * one for the other (RFC 8725 §3.11 explicit typing + mutually-exclusive rules).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PERMS VOCABULARY (exhaustive for v1)
 * ────────────────────────────────────────────────────────────────────────────
 *   "read"  → S3 GetObject within the scoped bucket+prefix.
 *   "write" → S3 PutObject (and multipart upload) within the scoped bucket+prefix.
 *   "list"  → S3 ListObjects(V2) of the scoped bucket, restricted to the prefix.
 * The string→S3-action mapping is the GATEWAY's responsibility (P12 owns its S3
 * dialect); the issuer commits only to this stable vocabulary. New perms in a
 * future v1 minor are additive and a v1 gateway MUST ignore perms it does not
 * recognise (never treat an unknown perm as a grant). Removing/renaming a perm
 * requires bumping `mcp.v`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FORWARD COMPATIBILITY
 * ────────────────────────────────────────────────────────────────────────────
 *  • `mcp.v` is the MAJOR version. Bump it for any breaking change (perm
 *    semantics, the prefix value/rule, multi-bucket). A gateway pinned to v1
 *    MUST reject v2+.
 *  • Multiple scope entries are reserved for a future version; v1 emits and a
 *    v1 gateway enforces exactly one. (The array shape is intentional so the
 *    contract doesn't have to change to support it later.)
 *  • Unknown extra fields inside a v1 scope must NOT alter authorization — a
 *    v1 gateway ignores them.
 */

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

// ── Contract constants (exported so tests + future tooling pin them) ──────────
export const MCP_TOKEN_TYP = 'mcp-s3+jwt';
export const MCP_TOKEN_USE = 'mcp_s3';
export const MCP_TOKEN_ISS = 'pinning-webui';
export const MCP_TOKEN_AUD = 'fula-s3-gateway';
export const MCP_SCOPE_VERSION = 1 as const;

/** The single AI-workspace bucket an MCP token is scoped to in v1. */
export const MCP_WORKSPACE_BUCKET = 'fula-ai-workspace';

/** The AI-workspace key namespace the MCP writes under; matches fula-mcp store.rs. */
export const MCP_WORKSPACE_PREFIX = 'ai/';

/** Exhaustive v1 permission vocabulary. */
export const MCP_PERMS = ['read', 'write', 'list'] as const;
export type McpPerm = (typeof MCP_PERMS)[number];

/** Default and bounds for the token lifetime (seconds). */
export const MCP_TOKEN_TTL_DEFAULT_SECONDS = 3600; // 1h
export const MCP_TOKEN_TTL_MIN_SECONDS = 60; // 1m floor (guards misconfig)
export const MCP_TOKEN_TTL_MAX_SECONDS = 24 * 3600; // 24h ceiling

export interface McpScopeEntry {
  bucket: string;
  prefix: string;
  perms: McpPerm[];
}

export interface McpScopeClaim {
  v: typeof MCP_SCOPE_VERSION;
  scopes: McpScopeEntry[];
}

export interface McpTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  token_use: string;
  mcp: McpScopeClaim;
}

/**
 * Build the v1 scope claim. The prefix is the CONSTANT `ai/` (MCP_WORKSPACE_PREFIX)
 * — the AI-workspace key namespace the MCP writes under (keys are `ai/<category>/...`
 * in `fula-ai-workspace`; the gateway stores them verbatim), so a per-user prefix
 * would reject every real MCP op. CROSS-USER ISOLATION is NOT this prefix's job: it
 * comes from the gateway opening buckets per `(hashed_user_id, bucket)` plus the JWT
 * `sub`. P12 enforces `prefix === "ai/"` (segment-boundary).
 */
export function buildMcpScopeClaim(
  perms: McpPerm[] = [...MCP_PERMS],
  bucket: string = MCP_WORKSPACE_BUCKET,
): McpScopeClaim {
  return {
    v: MCP_SCOPE_VERSION,
    scopes: [
      {
        bucket,
        prefix: MCP_WORKSPACE_PREFIX,
        perms,
      },
    ],
  };
}

/**
 * Clamp a requested TTL (seconds) into the allowed range. Non-finite / absent
 * → default. Out-of-range → clamped to the nearest bound (never throws, so a
 * bad env value degrades safely rather than wedging issuance).
 */
export function resolveMcpTtlSeconds(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) {
    return MCP_TOKEN_TTL_DEFAULT_SECONDS;
  }
  const n = Math.floor(requested);
  if (n < MCP_TOKEN_TTL_MIN_SECONDS) return MCP_TOKEN_TTL_MIN_SECONDS;
  if (n > MCP_TOKEN_TTL_MAX_SECONDS) return MCP_TOKEN_TTL_MAX_SECONDS;
  return n;
}

export interface MintMcpTokenResult {
  token: string;
  claims: McpTokenClaims;
}

/**
 * Mint a scoped MCP JWT for `userId`, signed HS256 with `jwtSecret` (the shared
 * signer — NOT a new key). This deliberately does NOT reuse `generateJwtApiKey`
 * (that hard-codes the broad `storage:*` scope and no exp) and does NOT persist
 * the token in `api_keys` — MCP tokens are stateless; the only server state is
 * the revoked-jti list.
 */
export function mintMcpToken(
  userId: string,
  jwtSecret: string,
  opts?: { ttlSeconds?: number; perms?: McpPerm[]; bucket?: string; jti?: string; nowSeconds?: number },
): MintMcpTokenResult {
  const now = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = resolveMcpTtlSeconds(opts?.ttlSeconds);
  const jti = opts?.jti ?? uuidv4();

  const claims: McpTokenClaims = {
    iss: MCP_TOKEN_ISS,
    aud: MCP_TOKEN_AUD,
    sub: userId,
    jti,
    iat: now,
    nbf: now,
    exp: now + ttl,
    token_use: MCP_TOKEN_USE,
    mcp: buildMcpScopeClaim(opts?.perms, opts?.bucket),
  };

  // Sign the fully-formed claim set (we own iat/nbf/exp explicitly so the
  // contract is exact); set the explicit media type in the JOSE header.
  const token = jwt.sign(claims, jwtSecret, {
    algorithm: 'HS256',
    header: { alg: 'HS256', typ: MCP_TOKEN_TYP },
  });

  return { token, claims };
}

/**
 * Reference verifier for the token kind — mirrors what P12 must enforce. Used
 * by the webui's own revocation-check endpoint and by tests so the contract is
 * exercised in-repo. Returns the decoded claims on success; throws on any
 * contract violation. (P12 should implement the equivalent in its own stack;
 * this is the canonical reference.)
 */
export function verifyMcpToken(
  token: string,
  jwtSecret: string,
  opts?: { clockToleranceSeconds?: number; maxTtlSeconds?: number; expectedSub?: string },
): McpTokenClaims {
  const clockTolerance = opts?.clockToleranceSeconds ?? 120;
  const maxTtl = opts?.maxTtlSeconds ?? MCP_TOKEN_TTL_MAX_SECONDS;

  // jwt.verify checks signature, exp, nbf (with tolerance), iss and aud.
  const decoded = jwt.verify(token, jwtSecret, {
    algorithms: ['HS256'],
    issuer: MCP_TOKEN_ISS,
    audience: MCP_TOKEN_AUD,
    clockTolerance,
  }) as Record<string, unknown>;

  // typ lives in the JOSE header — decode it separately.
  const header = decodeJwtHeader(token);
  if (header?.typ !== MCP_TOKEN_TYP) {
    throw new Error('mcp token: wrong typ header');
  }
  if (decoded.token_use !== MCP_TOKEN_USE) {
    throw new Error('mcp token: wrong token_use');
  }
  const mcp = decoded.mcp as McpScopeClaim | undefined;
  if (!mcp || mcp.v !== MCP_SCOPE_VERSION) {
    throw new Error('mcp token: unsupported mcp.v');
  }
  if (!Array.isArray(mcp.scopes) || mcp.scopes.length !== 1) {
    throw new Error('mcp token: v1 requires exactly one scope');
  }
  const exp = Number(decoded.exp);
  const iat = Number(decoded.iat);
  if (Number.isFinite(exp) && Number.isFinite(iat) && exp - iat > maxTtl) {
    throw new Error('mcp token: ttl exceeds max');
  }
  const sub = String(decoded.sub);
  for (const s of mcp.scopes) {
    if (s.prefix !== MCP_WORKSPACE_PREFIX) {
      throw new Error('mcp token: prefix must be the ai/ workspace namespace');
    }
    if (!Array.isArray(s.perms) || s.perms.some((p) => !MCP_PERMS.includes(p as McpPerm))) {
      throw new Error('mcp token: unknown perm');
    }
  }
  if (opts?.expectedSub && sub !== opts.expectedSub) {
    throw new Error('mcp token: sub mismatch');
  }
  return decoded as unknown as McpTokenClaims;
}

/**
 * Decide what (if anything) a revoke request may revoke. SECURITY-CRITICAL:
 * this is the access-control gate for revocation. It CRYPTOGRAPHICALLY VERIFIES
 * the presented token before trusting any claim, so an attacker cannot take
 * their own valid token, swap in a victim's `jti`, and have the (now-broken)
 * signature pass — verification fails first.
 *
 * Returns either the revocation target (`jti`/`exp` from the VERIFIED claims)
 * or an error with the HTTP status the handler should return:
 *   - token fails verification (bad sig / expired / wrong kind) → 400
 *   - token verifies but belongs to a different user            → 403
 *
 * There is deliberately NO "revoke by bare jti" path: MCP tokens are stateless
 * and never stored server-side, so ownership of a bare jti cannot be
 * established — a caller must PRESENT the still-valid token they want killed.
 * (Already-expired tokens need no revocation: they are dead by `exp`.) A future
 * "revoke all my tokens" would be a per-user epoch claim the gateway compares,
 * not a bare-jti revoke.
 */
export function resolveRevocationTarget(
  token: string,
  jwtSecret: string,
  callerUserId: string,
):
  | { ok: true; jti: string; exp: number; userId: string }
  | { ok: false; status: 400 | 403; error: string } {
  let claims: McpTokenClaims;
  try {
    claims = verifyMcpToken(token, jwtSecret);
  } catch {
    // Bad signature, expired, or not a well-formed MCP token. We don't leak
    // which — a forged/tampered token is indistinguishable from junk here.
    return { ok: false, status: 400, error: 'invalid or expired token' };
  }
  if (claims.sub !== callerUserId) {
    return { ok: false, status: 403, error: 'cannot revoke another user\'s token' };
  }
  return { ok: true, jti: claims.jti, exp: claims.exp, userId: claims.sub };
}

/** Decode the JOSE header (base64url JSON) without verifying — for `typ`. */
export function decodeJwtHeader(token: string): { alg?: string; typ?: string } | null {
  const part = token.split('.')[0];
  if (!part) return null;
  try {
    const json = Buffer.from(part, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Decode (without verifying) just enough of a token to drive revocation: the
 * `jti` and `exp`. Returns nulls on a malformed token rather than throwing.
 */
export function decodeMcpJtiExp(token: string): { jti: string | null; exp: number | null } {
  const part = token.split('.')[1];
  if (!part) return { jti: null, exp: null };
  try {
    const json = Buffer.from(part, 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    return { jti, exp };
  } catch {
    return { jti: null, exp: null };
  }
}
