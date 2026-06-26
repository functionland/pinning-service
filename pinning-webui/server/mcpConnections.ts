/**
 * MCP connection lifecycle — pure helpers (crypto + non-widening re-mint).
 * =======================================================================
 *
 * The connection refresh flow has ONE security invariant: a refresh re-mints
 * ONLY the connection's STORED workspace scope (bucket `fula-ai-workspace`,
 * prefix `ai/`, the SAME perms captured at pairing). It must never widen scope
 * and never hand back the user's broader account credential. The request body
 * must NEVER influence the minted scope.
 *
 * To make that invariant STRUCTURALLY testable without a database, the scope
 * extraction + re-mint live here as a pure function that reads ONLY a stored
 * connection scope (never an Express request). The endpoint in app.ts is then
 * incapable of reading request-supplied scope — it can only pass the row it
 * loaded from `mcp_connections`.
 *
 * WHY NOT `{ ...conn.scope }`: `mintMcpToken`'s opts take `{ perms, bucket }`,
 * but a stored scope claim is `{ v, scopes: [{ bucket, prefix, perms }] }` —
 * it has NO top-level `perms`/`bucket` keys. Spreading it would leave both
 * `undefined`, and `buildMcpScopeClaim` DEFAULTS undefined perms to the FULL
 * set `['read','write','list']`. That is exactly the widening bug this module
 * exists to prevent: we extract `scopes[0].perms` / `scopes[0].bucket`
 * EXPLICITLY. (`prefix` is intentionally NOT passed — `mintMcpToken` reapplies
 * the constant `ai/`; a stored prefix is only ever that constant anyway.)
 */
import crypto from 'crypto';
import { mintMcpToken, type McpPerm, type MintMcpTokenResult } from './mcpTokens.js';
import { mintCollabWriteToken, type MintCollabTokenResult } from './collabTokens.js';

/** Raw entropy (bytes) of a connection refresh token. 256 bits → infeasible to brute-force. */
export const MCP_REFRESH_TOKEN_BYTES = 32;

export interface NewRefreshToken {
  /** The plaintext token — returned to the client ONCE, then never persisted. */
  token: string;
  /** sha256 of the token, HEX (64 chars) — the ONLY thing stored server-side. */
  hash: string;
}

/**
 * Mint a new connection refresh token: a high-entropy random secret plus the
 * sha256 hash we persist. The plaintext is shown to the caller a single time
 * (it goes into the FxFiles bundle); only `hash` is stored. Generating the hash
 * here (not at the call site) keeps the "store only the hash, never the secret"
 * rule in one place.
 */
export function newRefreshToken(): NewRefreshToken {
  const token = crypto.randomBytes(MCP_REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** sha256(token) as lowercase hex. The stored/looked-up form of a refresh token. */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The minimal connection shape the re-mint needs (subset of the DB row). */
export interface StoredConnectionScope {
  user_id: string;
  mcp_pub_b64: string;
  scope: { v: number; scopes: Array<{ bucket: string; prefix: string; perms: string[] }> };
}

/**
 * Re-mint a fresh short-lived JWT for a connection, pinned to its STORED scope.
 *
 * SECURITY-CRITICAL: this reads scope ONLY from `conn` (a row loaded from
 * `mcp_connections`). It cannot widen — perms/bucket come verbatim from the
 * frozen claim, and the connection binding (`cnf`) is re-applied so the new
 * token stays tied to the same MCP pubkey. A fresh `jti` is used (or one may be
 * supplied for tests). Any request-supplied scope is structurally unreachable
 * here because this function has no access to the request.
 *
 * The defensive read of `scopes[0]` falls back to an EMPTY perms array (not
 * undefined) if a row were ever malformed — fail CLOSED (no perms) rather than
 * letting mint's all-perms default kick in.
 */
export function mintFromConnection(
  conn: StoredConnectionScope,
  jwtSecret: string,
  jti?: string,
  ttlSeconds?: number,
): MintMcpTokenResult {
  const entry = conn.scope?.scopes?.[0];
  const perms = (Array.isArray(entry?.perms) ? entry!.perms : []) as McpPerm[];
  const bucket = typeof entry?.bucket === 'string' ? entry!.bucket : undefined;

  return mintMcpToken(conn.user_id, jwtSecret, {
    perms, // EXPLICIT — never undefined (would default to all perms)
    bucket,
    mcpPubB64: conn.mcp_pub_b64, // re-apply the connection binding (cnf)
    ...(jti !== undefined ? { jti } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
}

/** The minimal connection shape the collab re-mint needs (subset of the DB row, incl. id). */
export interface StoredCollabConnection {
  id: string;
  user_id: string;
  mcp_pub_b64: string;
  scope: { collab?: { groupIds?: string[] } };
}

/**
 * Re-mint a fresh short-lived COLLAB-WRITE token for a connection, pinned to its
 * STORED collab authorization (`scope.collab.groupIds`). Mirrors
 * `mintFromConnection`'s invariant: reads groupIds ONLY off the row (never a
 * request body), re-applies the connection binding (cnf = the row's pubkey), and
 * stamps `cid = conn.id` for the synchronous revoked check on the write path.
 *
 * Returns `null` when the connection has NO collab authorization (no groupIds) —
 * the caller then simply omits a collab token from the response. FAIL CLOSED:
 * a malformed/absent groupIds array yields null, never a wide token. The TTL
 * defaults to the collab token's own SHORT default (<=10 min), independent of
 * the mcp_s3 token TTL.
 */
export function mintCollabFromConnection(
  conn: StoredCollabConnection,
  jwtSecret: string,
  ttlSeconds?: number,
  jti?: string,
): MintCollabTokenResult | null {
  const groupIds = Array.isArray(conn.scope?.collab?.groupIds) ? conn.scope.collab!.groupIds! : [];
  if (groupIds.length === 0) return null;
  return mintCollabWriteToken(conn.user_id, jwtSecret, {
    connectionId: conn.id,
    groupIds,
    mcpPubB64: conn.mcp_pub_b64,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(jti !== undefined ? { jti } : {}),
  });
}
