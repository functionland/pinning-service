/**
 * Collab-write token — a GROUP-SCOPED JWT that authorizes an AI/MCP agent to
 * perform collaboration WRITES (upload / manifest / manifest-sync) on the
 * pinning-webui's own collab routes, WITHOUT a full user api_key.
 * ============================================================================
 *
 * This is a DISTINCT token kind from the `mcp_s3` gateway token in
 * `mcpTokens.ts`. The two share the same HS256 signing secret (`JWT_SECRET`),
 * so they MUST be separated by explicit, mutually-exclusive discriminators so
 * one can never be mistaken for the other (RFC 8725 §3.11 explicit typing):
 *
 *   ┌────────────────┬──────────────────────┬───────────────────────────────┐
 *   │                │ mcp_s3 (gateway)     │ collab_write (THIS module)     │
 *   ├────────────────┼──────────────────────┼───────────────────────────────┤
 *   │ header.typ     │ "mcp-s3+jwt"         │ "collab-write+jwt"             │
 *   │ aud            │ "fula-s3-gateway"    │ "pinning-webui-collab"         │
 *   │ token_use      │ "mcp_s3"             │ "collab_write"                 │
 *   │ scope claim    │ mcp.{scopes:[…]}     │ collab.{cid, groupIds:[…]}     │
 *   │ consumed by    │ the Fula S3 gateway  │ pinning-webui collab routes    │
 *   └────────────────┴──────────────────────┴───────────────────────────────┘
 *
 * Because the collab routes only EVER accept aud="pinning-webui-collab" +
 * token_use="collab_write" (single accepted aud per route — no "either token is
 * fine" fallback), an `mcp_s3` token is rejected on a collab route, and a
 * `collab_write` token is rejected by the gateway (which enforces the mcp_s3
 * discriminators). Defense in depth: even an attacker who could swap the `aud`
 * cannot, because the body is signed.
 *
 * KID: there is a SINGLE shared HS256 secret here — no key registry / JWKS — so
 * a `kid` would select nothing. The `typ` + `aud` + `token_use` triple is the
 * real discriminator (matching the `mcp-s3+jwt` precedent). We deliberately do
 * NOT emit a non-functional `kid`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CLAIMS
 * ────────────────────────────────────────────────────────────────────────────
 *   header: { "alg": "HS256", "typ": "collab-write+jwt" }
 *   payload: {
 *     "iss": "pinning-webui",
 *     "aud": "pinning-webui-collab",
 *     "sub": "<64-hex user_id>",       // the connection owner (pairing owner)
 *     "jti": "<uuid v4>",
 *     "iat": …, "nbf": …, "exp": …,    // short: <=600s (10 min)
 *     "token_use": "collab_write",
 *     "collab": {
 *       "v": 1,
 *       "cid": "<mcp_connections.id>", // the connection row this came from —
 *                                      // used for the SYNCHRONOUS revoked check
 *       "groupIds": ["<uuid>", …]      // the AUTHORIZED collab groups (lowercased)
 *     },
 *     "cnf": { "mcp_pub_b64": "<b64 X25519 pubkey>" }  // agent binding (RFC 7800)
 *   }
 *
 * SECURITY INVARIANTS:
 *  • The authorized `groupIds` come ONLY from the stored `mcp_connections` row
 *    (`scope.collab.groupIds`) at mint time — NEVER from a request body. See
 *    `mintCollabFromConnection` in mcpConnections.ts.
 *  • `cnf` is REQUIRED (unlike the optional cnf on mcp_s3): a collab-write token
 *    is always agent-bound. A missing/invalid cnf is a forged token → reject.
 *  • Group membership is checked against `collab.groupIds` from the VERIFIED
 *    token. Revocation (connection revoked / group kill-switch) is checked
 *    SYNCHRONOUSLY against the DB on every write — never the token alone.
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { normalizeMcpPubB64, decodeJwtHeader } from './mcpTokens.js';

/**
 * DOMAIN-SEPARATED SIGNING KEY. The collab-write token shares the deployment's
 * single HS256 `JWT_SECRET` with the `mcp_s3` gateway token and the long-lived
 * storage api-keys — but we sign collab-write tokens with a key DERIVED from it
 * (HKDF-style HMAC label), NOT the raw secret. Consequences:
 *   • An `mcp_s3` / storage JWT (signed with the RAW secret) presented to a
 *     collab route FAILS the SIGNATURE check under the derived key — it can
 *     never be confused for a collab-write token even if a future verifier
 *     forgets a `typ`/`aud`/`token_use` check. (We keep those checks anyway,
 *     defense in depth.)
 *   • A collab-write token (signed with the DERIVED key) presented to the
 *     gateway's mcp_s3 verifier (raw secret) likewise fails its signature.
 * The label is versioned so the key can be rotated independently later. This is
 * an INTERNAL key (collab-write tokens are consumed only by this server's own
 * routes), so deriving it changes no cross-service contract.
 */
export const COLLAB_SIGNING_KEY_LABEL = 'pinning-webui/collab-write/v1';
export function deriveCollabSigningKey(jwtSecret: string): Buffer {
  return crypto.createHmac('sha256', jwtSecret).update(COLLAB_SIGNING_KEY_LABEL).digest();
}

// ── Contract constants (exported so the routes + tests pin them) ──────────────
export const COLLAB_TOKEN_TYP = 'collab-write+jwt';
export const COLLAB_TOKEN_USE = 'collab_write';
export const COLLAB_TOKEN_ISS = 'pinning-webui';
export const COLLAB_TOKEN_AUD = 'pinning-webui-collab';
export const COLLAB_SCOPE_VERSION = 1 as const;

/**
 * Lifetime bounds (seconds). The task mandates a SHORT TTL (<=10 min); the agent
 * re-mints via the connection refresh-token flow. Default == max so a misconfig
 * can never widen it; min guards a degenerate value.
 */
export const COLLAB_TOKEN_TTL_DEFAULT_SECONDS = 600; // 10m
export const COLLAB_TOKEN_TTL_MIN_SECONDS = 60; // 1m floor
export const COLLAB_TOKEN_TTL_MAX_SECONDS = 600; // 10m ceiling (hard cap)

/** Max authorized groups per connection/token (sanity cap; folder-scale is 1). */
export const COLLAB_MAX_GROUP_IDS = 200;

/** Canonical UUID v4-ish shape (same pattern the collab routes use, case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCollabGroupId(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/**
 * Normalize a list of group ids: validate each as a UUID, de-duplicate (EXACT,
 * case-sensitive), and cap the count. Throws on any non-UUID member or over-cap
 * — FAIL CLOSED (a malformed group list must not silently widen/narrow).
 *
 * CASE-SENSITIVITY: we do NOT lowercase. A collab group's canonical identity is
 * its EXACT `group_id` string — that is the `collab_manifests` primary key and
 * the S3 key segment (`.fula/collab/<groupId>/…`). Lowercasing HERE but keying
 * storage by the raw groupId would let an authorization for `ABC` match a write
 * to `abc`, which storage treats as a DIFFERENT group — creating a phantom,
 * creator-less row the kill switch can't gate. Comparing case-sensitively keeps
 * the auth identity == the storage identity (a case mismatch fails SAFE with a
 * 403, never a silent split). UUIDs are conventionally lowercase, so a
 * consistent caller never hits a mismatch.
 */
export function normalizeGroupIds(groupIds: unknown): string[] {
  if (!Array.isArray(groupIds)) {
    throw new Error('collab token: groupIds must be an array');
  }
  const out = new Set<string>();
  for (const g of groupIds) {
    if (!isCollabGroupId(g)) {
      throw new Error('collab token: every groupId must be a UUID');
    }
    out.add(g);
  }
  if (out.size > COLLAB_MAX_GROUP_IDS) {
    throw new Error(`collab token: too many groupIds (max ${COLLAB_MAX_GROUP_IDS})`);
  }
  return [...out];
}

export interface CollabScopeClaim {
  v: typeof COLLAB_SCOPE_VERSION;
  /** The mcp_connections.id this token was minted from (synchronous revoked check). */
  cid: string;
  /** The authorized collab group ids (lowercased UUIDs). */
  groupIds: string[];
}

export interface CollabCnfClaim {
  mcp_pub_b64: string;
}

export interface CollabTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  token_use: string;
  collab: CollabScopeClaim;
  /** REQUIRED — a collab-write token is always agent-bound. */
  cnf: CollabCnfClaim;
}

/** Clamp a requested TTL into [MIN, MAX]; non-finite/absent → default. Never throws. */
export function resolveCollabTtlSeconds(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) {
    return COLLAB_TOKEN_TTL_DEFAULT_SECONDS;
  }
  const n = Math.floor(requested);
  if (n < COLLAB_TOKEN_TTL_MIN_SECONDS) return COLLAB_TOKEN_TTL_MIN_SECONDS;
  if (n > COLLAB_TOKEN_TTL_MAX_SECONDS) return COLLAB_TOKEN_TTL_MAX_SECONDS;
  return n;
}

export interface MintCollabTokenResult {
  token: string;
  claims: CollabTokenClaims;
}

/**
 * Mint a collab-write JWT for `userId` (the connection owner), bound to the
 * agent pubkey, scoped to `connectionId` + `groupIds`. Signed HS256 with the
 * SHARED `jwtSecret`. FAIL CLOSED: throws if the binding pubkey is not a valid
 * 32-byte key, if `connectionId` is empty, or if any groupId is not a UUID — so
 * we never issue a token that is malformed/unbound while a caller believes it is
 * valid. `groupIds` MAY be empty only if explicitly allowed by the caller; by
 * default an empty set is rejected (a token authorizing zero groups is useless
 * and usually signals a bug).
 */
export function mintCollabWriteToken(
  userId: string,
  jwtSecret: string,
  opts: {
    connectionId: string;
    groupIds: string[];
    mcpPubB64: string;
    ttlSeconds?: number;
    jti?: string;
    nowSeconds?: number;
    allowEmptyGroups?: boolean;
  },
): MintCollabTokenResult {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('collab token: userId required');
  }
  if (typeof opts.connectionId !== 'string' || opts.connectionId.length === 0) {
    throw new Error('collab token: connectionId required');
  }
  const cnfPub = normalizeMcpPubB64(opts.mcpPubB64);
  if (!cnfPub) {
    throw new Error('collab token: mcp_pub_b64 must be base64 of a 32-byte key');
  }
  const groupIds = normalizeGroupIds(opts.groupIds);
  if (groupIds.length === 0 && !opts.allowEmptyGroups) {
    throw new Error('collab token: groupIds must be non-empty');
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = resolveCollabTtlSeconds(opts.ttlSeconds);
  const jti = opts.jti ?? uuidv4();

  const claims: CollabTokenClaims = {
    iss: COLLAB_TOKEN_ISS,
    aud: COLLAB_TOKEN_AUD,
    sub: userId,
    jti,
    iat: now,
    nbf: now,
    exp: now + ttl,
    token_use: COLLAB_TOKEN_USE,
    collab: {
      v: COLLAB_SCOPE_VERSION,
      cid: opts.connectionId,
      groupIds,
    },
    cnf: { mcp_pub_b64: cnfPub },
  };

  const token = jwt.sign(claims, deriveCollabSigningKey(jwtSecret), {
    algorithm: 'HS256',
    header: { alg: 'HS256', typ: COLLAB_TOKEN_TYP },
  });

  return { token, claims };
}

/**
 * Verify a collab-write token. Mirrors `verifyMcpToken`: checks signature, exp,
 * nbf (with clock tolerance), iss and aud via jwt.verify, then the
 * collab-specific discriminators (typ header, token_use, collab.v), the scope
 * shape (cid string, groupIds array of UUIDs), and the REQUIRED cnf binding.
 * Returns the decoded claims (with cnf + groupIds canonicalized) on success;
 * throws on any contract violation. Does NOT consult revocation — that is a
 * synchronous DB check on the write path (a verified token can still be denied).
 */
export function verifyCollabWriteToken(
  token: string,
  jwtSecret: string,
  opts?: { clockToleranceSeconds?: number; maxTtlSeconds?: number; expectedSub?: string },
): CollabTokenClaims {
  // Short-lived agent tokens: a tight skew window (60s) keeps the effective
  // validity close to the <=600s TTL.
  const clockTolerance = opts?.clockToleranceSeconds ?? 60;
  const maxTtl = opts?.maxTtlSeconds ?? COLLAB_TOKEN_TTL_MAX_SECONDS;

  // jwt.verify checks signature (under the DERIVED key — see deriveCollabSigningKey),
  // exp, nbf (with tolerance), iss and aud. alg is pinned to HS256 (never trust
  // the header alg / accept "none").
  const decoded = jwt.verify(token, deriveCollabSigningKey(jwtSecret), {
    algorithms: ['HS256'],
    issuer: COLLAB_TOKEN_ISS,
    audience: COLLAB_TOKEN_AUD,
    clockTolerance,
  }) as Record<string, unknown>;

  // typ lives in the JOSE header — decode it separately.
  const header = decodeJwtHeader(token);
  if (header?.typ !== COLLAB_TOKEN_TYP) {
    throw new Error('collab token: wrong typ header');
  }
  if (decoded.token_use !== COLLAB_TOKEN_USE) {
    throw new Error('collab token: wrong token_use');
  }
  const collab = decoded.collab as Partial<CollabScopeClaim> | undefined;
  if (!collab || collab.v !== COLLAB_SCOPE_VERSION) {
    throw new Error('collab token: unsupported collab.v');
  }
  if (typeof collab.cid !== 'string' || collab.cid.length === 0) {
    throw new Error('collab token: collab.cid required');
  }
  // Canonicalize + validate the authorized groups (throws on any non-UUID).
  const groupIds = normalizeGroupIds(collab.groupIds);

  // exp AND iat are REQUIRED, and the TTL must be within bound. jwt.verify only
  // enforces exp WHEN PRESENT, so a token missing exp would otherwise never
  // expire; a missing iat would skip the TTL bound. Both are always minted, so
  // requiring them is fail-closed defense in depth.
  const exp = Number(decoded.exp);
  const iat = Number(decoded.iat);
  if (!Number.isFinite(exp) || !Number.isFinite(iat) || exp - iat > maxTtl) {
    throw new Error('collab token: missing exp/iat or ttl exceeds max');
  }

  // cnf is REQUIRED and must be a valid 32-byte pubkey b64 (a malformed/missing
  // cnf is a forged/tampered token). Rewrite to canonical form for exact compare.
  const rawCnf = decoded.cnf as { mcp_pub_b64?: unknown } | undefined;
  const normalizedCnf = normalizeMcpPubB64(rawCnf?.mcp_pub_b64);
  if (!normalizedCnf) {
    throw new Error('collab token: cnf.mcp_pub_b64 must be base64 of a 32-byte key');
  }

  if (opts?.expectedSub && String(decoded.sub) !== opts.expectedSub) {
    throw new Error('collab token: sub mismatch');
  }

  (decoded as Record<string, unknown>).collab = { v: COLLAB_SCOPE_VERSION, cid: collab.cid, groupIds };
  (decoded as Record<string, unknown>).cnf = { mcp_pub_b64: normalizedCnf };
  return decoded as unknown as CollabTokenClaims;
}

/**
 * True iff `groupId` is in the token's authorized set. EXACT (case-sensitive)
 * match — the token's groupIds and the route `:groupId` are the same capability
 * string, and storage keys by the exact id (see normalizeGroupIds). Read this
 * ONLY off VERIFIED claims so the set cannot be spoofed.
 */
export function isGroupAuthorizedByToken(claims: CollabTokenClaims, groupId: string): boolean {
  if (typeof groupId !== 'string' || groupId.length === 0) return false;
  return claims.collab.groupIds.includes(groupId);
}
