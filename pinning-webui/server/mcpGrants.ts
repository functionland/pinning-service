/**
 * Phase 15a — MCP grant payload validation (pure, HTTP-free).
 * ==========================================================
 *
 * Validates the body of `POST /api/mcp/grants` before any DB write. Kept as a
 * pure function (no Express, no pg) so it can be unit-tested directly — like
 * P11's `resolveMcpTtlSeconds` / `buildMcpScopeClaim`.
 *
 * A grant carries a `ShareToken` (the `token_json`) whose path_scope /
 * permissions / expiry / id are PLAINTEXT; only the DEK inside is HPKE-sealed to
 * the MCP's pubkey. We DO NOT inspect or trust the sealed contents here — we
 * only validate the outer envelope the store needs: a parseable JSON token, the
 * three permission booleans, a scope string, and an optional numeric expiry. The
 * connection pubkey (`mcp_pub_b64`) is validated for the 32-byte invariant.
 *
 * NOTE: these `permissions` are REAL-file ops {can_read, can_write, can_delete}
 * and are INTENTIONALLY a different vocabulary from the JWT `mcp` scope perms
 * (["read","write","list"]). Do not conflate them.
 */
import { normalizeMcpPubB64 } from './mcpTokens.js';

/** Hard ceiling on grants per request (folder-scale; clear error past it). */
export const MCP_GRANTS_MAX_PER_REQUEST = 1000;

export interface ValidatedGrant {
  scope: string;
  permissions: { can_read: boolean; can_write: boolean; can_delete: boolean };
  token_json: string;
  expires_at: number | null;
}

export interface ValidatedGrantsPayload {
  mcpPubB64: string; // normalized (canonical standard-base64)
  grants: ValidatedGrant[];
}

export type ValidateGrantsResult =
  | { ok: true; value: ValidatedGrantsPayload }
  | { ok: false; status: 400 | 413; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate the POST /api/mcp/grants body. Returns the normalized payload or a
 * structured error with the HTTP status the handler should send. FAIL-CLOSED:
 * any malformed field rejects the WHOLE request (no partial inserts) so the
 * caller gets a clear, all-or-nothing result.
 */
export function validateGrantsPayload(body: unknown): ValidateGrantsResult {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }

  const mcpPubB64 = normalizeMcpPubB64(body.mcp_pub_b64);
  if (!mcpPubB64) {
    return { ok: false, status: 400, error: 'mcp_pub_b64 must be base64 of a 32-byte X25519 public key' };
  }

  const rawGrants = body.grants;
  if (!Array.isArray(rawGrants)) {
    return { ok: false, status: 400, error: 'grants must be an array' };
  }
  if (rawGrants.length === 0) {
    return { ok: false, status: 400, error: 'grants must be a non-empty array' };
  }
  if (rawGrants.length > MCP_GRANTS_MAX_PER_REQUEST) {
    return {
      ok: false,
      status: 413,
      error: `too many grants in one request (max ${MCP_GRANTS_MAX_PER_REQUEST})`,
    };
  }

  const grants: ValidatedGrant[] = [];
  for (let i = 0; i < rawGrants.length; i++) {
    const g = rawGrants[i];
    if (!isPlainObject(g)) {
      return { ok: false, status: 400, error: `grants[${i}] must be an object` };
    }

    if (typeof g.scope !== 'string' || g.scope.length === 0) {
      return { ok: false, status: 400, error: `grants[${i}].scope must be a non-empty string` };
    }

    const perms = g.permissions;
    if (!isPlainObject(perms) ||
        typeof perms.can_read !== 'boolean' ||
        typeof perms.can_write !== 'boolean' ||
        typeof perms.can_delete !== 'boolean') {
      return {
        ok: false,
        status: 400,
        error: `grants[${i}].permissions must have boolean can_read, can_write, can_delete`,
      };
    }

    if (typeof g.token_json !== 'string' || g.token_json.length === 0) {
      return { ok: false, status: 400, error: `grants[${i}].token_json must be a non-empty string` };
    }
    // The token_json must itself be parseable JSON (it's a serialized ShareToken).
    try {
      JSON.parse(g.token_json);
    } catch {
      return { ok: false, status: 400, error: `grants[${i}].token_json must be valid JSON` };
    }

    let expires_at: number | null = null;
    if (g.expires_at !== undefined && g.expires_at !== null) {
      if (typeof g.expires_at !== 'number' || !Number.isFinite(g.expires_at) || g.expires_at < 0) {
        return { ok: false, status: 400, error: `grants[${i}].expires_at must be a non-negative unix-seconds number` };
      }
      expires_at = Math.floor(g.expires_at);
    }

    grants.push({
      scope: g.scope,
      permissions: {
        can_read: perms.can_read,
        can_write: perms.can_write,
        can_delete: perms.can_delete,
      },
      token_json: g.token_json,
      expires_at,
    });
  }

  return { ok: true, value: { mcpPubB64, grants } };
}
