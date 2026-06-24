/**
 * Layer-1 gateway token refresh + per-session JWT cache (H3).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The custodied capability carries a long-lived, TOXIC `refresh_token` (it
 * re-mints scoped gateway JWTs). The gateway JWT itself is SHORT-LIVED; H3
 * refreshes it on demand by:
 *
 *     POST {capability.refresh_url}  { "refresh_token": <capability.refresh_token> }
 *       → 200 { "token": "<scoped gateway JWT>" }   (also accepts "access_token")
 *
 * This is the Layer-1 connection refresh (mirrors the local fula-mcp connection
 * lifecycle): the gateway JWT is what the EncryptedClient sends as the S3 bearer.
 *
 * CACHE (advisor-reviewed — Codex GPT-5.5 + Cursor):
 *   • We cache ONLY the short-lived gateway JWT — NEVER the workspace_secret,
 *     mcp_secret, or refresh_token. (Worker isolates are shared across users, so
 *     persisting secret material in a module global would risk cross-user leakage.)
 *   • The cache is keyed by the authenticated `userId` (SHA-256 hex) so one user's
 *     token can never be served to another.
 *   • Concurrent refreshes for the same user are COALESCED into one in-flight
 *     promise (avoids a refresh storm / token race when several tool calls land
 *     together).
 *   • Each cached entry has a conservative TTL; a refresh is forced on expiry OR
 *     when a caller reports a 401 from the gateway (retry-once — see the tools).
 *   • The token is treated as opaque: we never log it and never parse its claims
 *     here (the gateway is the authority on scope; this is just transport).
 */

/** A POST function injectable for tests; defaults to the global fetch. */
export type FetchLike = typeof fetch;

/** A cached short-lived gateway JWT + its computed expiry (ms epoch). */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Conservative client-side TTL for a gateway JWT when the refresh response does
 * not tell us the lifetime. Short enough to bound staleness; the 401-retry is the
 * backstop if the real token expires sooner.
 */
const DEFAULT_TTL_MS = 60_000;
/** Refresh this many ms BEFORE the computed expiry to avoid racing it mid-call. */
const EXPIRY_SKEW_MS = 5_000;
/** Hard timeout on the refresh POST. Fail closed on any error. */
const REFRESH_TIMEOUT_MS = 8_000;

/**
 * Per-isolate gateway-JWT cache. Keyed by userId. Holds ONLY the short-lived JWT
 * (no secret material). In-flight refreshes are coalesced via `inflight`.
 */
export class GatewayTokenCache {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly doFetch: FetchLike;
  private readonly now: () => number;

  constructor(opts: { fetchImpl?: FetchLike; now?: () => number } = {}) {
    // Same Workers gotcha as OpenBaoTransit: the global `fetch` must keep its
    // `this` (globalThis). Calling `this.doFetch(...)` otherwise throws "Illegal
    // invocation". Bind the default so the method-style call is safe.
    this.doFetch = opts.fetchImpl ?? fetch.bind(globalThis);
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Return a valid gateway JWT for `userId`, refreshing if absent/expired (or if
   * `force` is set — used after a 401). Concurrent calls for the same user share
   * one refresh.
   */
  async getToken(
    userId: string,
    refreshUrl: string,
    refreshToken: string,
    force = false,
  ): Promise<string> {
    if (!force) {
      const hit = this.cache.get(userId);
      if (hit && this.now() < hit.expiresAt - EXPIRY_SKEW_MS) {
        return hit.token;
      }
    } else {
      this.cache.delete(userId);
    }

    // Coalesce concurrent refreshes for this user.
    const existing = this.inflight.get(userId);
    if (existing) return existing;

    const p = this.refresh(userId, refreshUrl, refreshToken).finally(() => {
      this.inflight.delete(userId);
    });
    this.inflight.set(userId, p);
    return p;
  }

  /** Invalidate the cached token for a user (e.g. after a 401, before retry). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private async refresh(
    userId: string,
    refreshUrl: string,
    refreshToken: string,
  ): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.doFetch(refreshUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: ctrl.signal,
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "AbortError";
      throw new GatewayRefreshError(
        timedOut ? "gateway token refresh timed out" : "gateway token refresh failed",
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Coarse class only — never echo the gateway body (avoid leaking context).
      throw new GatewayRefreshError(`gateway token refresh rejected (status ${res.status})`);
    }
    let body: { token?: unknown; access_token?: unknown; expires_in?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new GatewayRefreshError("gateway token refresh returned non-JSON");
    }
    const token =
      typeof body.token === "string" && body.token
        ? body.token
        : typeof body.access_token === "string" && body.access_token
          ? body.access_token
          : null;
    if (!token) {
      throw new GatewayRefreshError("gateway token refresh returned no token");
    }
    const ttlMs =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in * 1000
        : DEFAULT_TTL_MS;
    this.cache.set(userId, { token, expiresAt: this.now() + ttlMs });
    return token;
  }
}

/** Raised for ANY gateway-refresh failure. Carries no secret. */
export class GatewayRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRefreshError";
  }
}

/** One shared cache per isolate (created lazily; safe — holds only short JWTs). */
let sharedCache: GatewayTokenCache | undefined;
export function gatewayTokenCache(): GatewayTokenCache {
  if (!sharedCache) sharedCache = new GatewayTokenCache();
  return sharedCache;
}
