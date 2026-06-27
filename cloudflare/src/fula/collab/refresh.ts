/**
 * Collab write-token refresh + refresh-on-auth-retry-once — Worker (TS) port of
 * the Rust `crates/fula-mcp/src/{refresh,retry}.rs`.
 *
 * The collaboration WRITE endpoints carry a short-lived group-scoped Bearer
 * (`collab_write_token`). When it expires the route replies 401/403. Rather than
 * fail the write, the Worker silently re-mints the token via the connection
 * refresh flow and retries EXACTLY ONCE.
 *
 * ## ⚠️ Field name: `collabToken`, NOT `token`
 *
 * The pinning-webui `POST /api/mcp/tokens/refresh-connection` returns BOTH a
 * gateway JWT (field `token`) AND the collab-write token (field **`collabToken`**)
 * — see the server contract (PR #69 `app.ts`). The Rust `refresh.rs` reads `token`
 * (it was written for the gateway-JWT refresh and is a latent mismatch for the
 * collab path); the Worker reads **`collabToken`** so the refreshed Bearer is
 * actually a `collab_write` token the collab routes accept. (We deliberately do
 * NOT fall back to `token` — that is the gateway JWT and would fail the collab
 * route's aud/signature check.)
 */

import { CollabError } from "./client.js";

/** Per-request timeout for the refresh POST (short — it is on a retried op's path). */
const REFRESH_TIMEOUT_MS = 5000;

/** Why a collab write-token refresh failed (bounded + secret-free). */
export type RefreshErrorKind = "revoked" | "transport" | "httpStatus" | "missingToken" | "notConfigured";

export class RefreshError extends Error {
  constructor(
    readonly kind: RefreshErrorKind,
    readonly status?: number,
  ) {
    super(`collab write-token refresh: ${kind}${status !== undefined ? ` (HTTP ${status})` : ""}`);
    this.name = "RefreshError";
  }
}

/**
 * PURE policy: map a refresh HTTP `(status, body)` to a fresh collab-write token
 * or a {@link RefreshError}. Reads the **`collabToken`** field (the L1a contract
 * also returns `token`/`jti`/`expiresAt` which we ignore). 401/403 ⇒ revoked
 * (terminal); any other non-2xx ⇒ httpStatus; a 2xx without a non-empty
 * `collabToken` ⇒ missingToken (we never swap in nothing).
 */
export function parseRefreshResponse(status: number, body: string): string {
  if (status === 401 || status === 403) throw new RefreshError("revoked", status);
  if (status < 200 || status >= 300) throw new RefreshError("httpStatus", status);
  let parsed: { collabToken?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RefreshError("missingToken");
  }
  if (typeof parsed.collabToken === "string" && parsed.collabToken.length > 0) {
    return parsed.collabToken;
  }
  throw new RefreshError("missingToken");
}

/**
 * Refresh the collab write token against pinning-webui's refresh endpoint.
 * POSTs `{ refresh_token }` and returns the fresh token parsed from `collabToken`.
 * A missing URL/token short-circuits to `notConfigured` with NO network touched.
 * NEVER logs the refresh token or the returned token.
 */
export async function refreshCollabWriteToken(
  fetchImpl: typeof fetch,
  refreshUrl: string | undefined,
  refreshToken: string | undefined,
): Promise<string> {
  if (!refreshUrl) throw new RefreshError("notConfigured");
  if (!refreshToken) throw new RefreshError("notConfigured");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetchImpl(refreshUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: ctrl.signal,
    });
  } catch {
    throw new RefreshError("transport");
  } finally {
    clearTimeout(timer);
  }
  const body = await resp.text().catch(() => "");
  return parseRefreshResponse(resp.status, body);
}

/** The mutable write-token + refresh creds a retried write needs. */
export interface WriteTokenContext {
  fetchImpl: typeof fetch;
  collabWriteToken(): string | undefined;
  setCollabWriteToken(t: string): void;
  refreshUrl?: string;
  refreshToken?: string;
}

/**
 * Run a single collab WRITE call with refresh-on-auth, retry-once. `op` takes the
 * current write token (by value, callable twice) and performs ONE write. Mirrors
 * the Rust `with_collab_write_retry`:
 *  - no write token configured → {@link CollabError} kind `writeNotConfigured`;
 *  - op succeeds → its value;
 *  - op fails with anything other than an `auth` error, or `auth` without a
 *    configured refresh → that error unchanged;
 *  - op fails with `auth` AND a refresh is configured → re-mint, swap it in, run
 *    op ONCE more; on any failure of the refresh / retry, surface the ORIGINAL
 *    auth error (no loop).
 */
export async function withCollabWriteRetry<T>(
  ctx: WriteTokenContext,
  op: (token: string) => Promise<T>,
): Promise<T> {
  const token = ctx.collabWriteToken();
  if (token === undefined) {
    throw new CollabError("writeNotConfigured", "collab write not configured: the bundle has no collab_write_token");
  }

  let original: unknown;
  try {
    return await op(token);
  } catch (e) {
    original = e;
  }

  const recoverable =
    original instanceof CollabError &&
    original.kind === "auth" &&
    ctx.refreshToken !== undefined &&
    ctx.refreshUrl !== undefined;
  if (!recoverable) throw original;

  let newToken: string;
  try {
    newToken = await refreshCollabWriteToken(ctx.fetchImpl, ctx.refreshUrl, ctx.refreshToken);
  } catch {
    throw original; // surface the original auth error, never the refresh error
  }
  ctx.setCollabWriteToken(newToken);
  try {
    return await op(newToken);
  } catch (retryErr) {
    // A retried write that fails for a NON-auth reason (e.g. a 409 version
    // conflict) must surface THAT error so the caller's compare-and-swap loop can
    // act on it — masking it as the original auth error defeats the CAS retry
    // (GLM-5.2 review). Only a repeated auth failure (or a non-CollabError) falls
    // back to the original auth error: never loop on auth, never leak refresh detail.
    if (retryErr instanceof CollabError && retryErr.kind !== "auth") throw retryErr;
    throw original;
  }
}
