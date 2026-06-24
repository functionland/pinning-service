/**
 * OpenBao `transit` client — the bridge to the KEK's trust domain (H2).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The master key-encryption-key (KEK) lives ONLY inside a self-hosted OpenBao
 * (the open-source HashiCorp Vault fork) on the user's own VPS — a DIFFERENT
 * trust domain than Cloudflare. The Worker NEVER holds the KEK. It holds an
 * AppRole (role-id + secret-id, as Worker secrets) whose OpenBao policy grants
 * ONLY `update` on `transit/encrypt/<key>` and `transit/decrypt/<key>` — so it
 * can wrap/unwrap per-record data keys (DEKs) but can never read or export the
 * KEK. (The policy + key are provisioned by scripts/openbao-setup.sh; the key is
 * created `exportable=false`, type `aes256-gcm96`.)
 *
 * This is what makes the custody guarantee hold: `wrapDek` returns an opaque
 * `vault:v<n>:…` string that is meaningless without a LIVE OpenBao to `unwrapDek`
 * it. A stolen D1 dump — even with the Worker's own secrets, including this
 * AppRole — cannot recover a DEK if OpenBao is unreachable or the AppRole is
 * revoked, because the unwrap MUST round-trip through the KEK that never leaves
 * OpenBao. (Honest scope: a live, reachable OpenBao + a stolen secret-id IS a
 * bulk-unwrap oracle by design — the Worker must unwrap to operate. That is the
 * runtime-compromise case, mitigated operationally, NOT the at-rest-dump case the
 * guarantee covers. See README / the report.)
 *
 * DESIGN (advisor-reviewed — Codex GPT-5.5 + Cursor):
 *   • AppRole login → short-lived client token, cached in-isolate until shortly
 *     before expiry. Multiple isolates each hold their own token (expected).
 *   • Exactly ONE retry on a 403 (token may have expired between cache + use):
 *     drop the cached token, re-login once, retry. NEVER an unbounded loop.
 *   • 5s timeout on every call via AbortController. Fail CLOSED on any error.
 *   • NEVER log the secret-id, the client token, the DEK plaintext, or the
 *     ciphertext. Errors carry only a coarse class string.
 *   • The HTTP client is injectable (`OpenBaoTransit` is constructed from a
 *     config object) so tests can point it at a real local `bao server -dev`, OR
 *     at a dead address to prove the fail-closed guarantee.
 */

/** Config the transit client needs — sourced from Worker secrets. */
export interface OpenBaoConfig {
  /** Base URL, e.g. https://bao.fx.land (no trailing slash needed). */
  addr: string;
  /** AppRole role-id (stable). */
  roleId: string;
  /** AppRole secret-id (rotating). */
  secretId: string;
  /** Transit key name (e.g. "fula-mcp-workspace-kek"). */
  transitKey: string;
  /** Per-request timeout (ms). Default 5000. */
  timeoutMs?: number;
  /**
   * Injectable fetch (defaults to the global). Tests may pass a stub, but the
   * DEFAULT real path is exercised against a live local OpenBao.
   */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms epoch) for token-expiry tests. Defaults to Date.now. */
  now?: () => number;
}

/** Thrown for ANY OpenBao failure. Carries a coarse class — never a secret. */
export class OpenBaoError extends Error {
  constructor(
    message: string,
    /** A short machine-readable class, e.g. "login", "wrap", "unwrap", "timeout". */
    readonly kind: string,
  ) {
    super(message);
    this.name = "OpenBaoError";
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
// Re-login this many ms BEFORE the server-reported token expiry, to avoid racing
// an expiry mid-request. (The 403 retry is the backstop if we still miss.)
const TOKEN_EXPIRY_SKEW_MS = 10_000;

export class OpenBaoTransit {
  private readonly addr: string;
  private readonly roleId: string;
  private readonly secretId: string;
  private readonly transitKey: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  /** Cached AppRole token + its computed expiry (ms epoch). In-isolate only. */
  private cachedToken: string | undefined;
  private cachedTokenExpiresAt = 0;

  constructor(cfg: OpenBaoConfig) {
    if (!cfg.addr || !cfg.roleId || !cfg.secretId || !cfg.transitKey) {
      // Construct-time guard: a misconfigured Worker must fail closed, loudly,
      // rather than silently behaving as if custody were available.
      throw new OpenBaoError("OpenBao config incomplete", "config");
    }
    this.addr = cfg.addr.replace(/\/+$/, "");
    this.roleId = cfg.roleId;
    this.secretId = cfg.secretId;
    this.transitKey = cfg.transitKey;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The global `fetch` MUST keep its original `this` (globalThis). Storing it
    // on an instance and calling `this.doFetch(...)` rebinds `this` to the
    // instance, which Workers reject with "Illegal invocation". Bind the default
    // so the method-style call is safe. (An injected test fetch is a plain fn.)
    this.doFetch = cfg.fetchImpl ?? fetch.bind(globalThis);
    this.now = cfg.now ?? (() => Date.now());
  }

  /**
   * Wrap a raw DEK (returns the opaque `vault:v<n>:…` ciphertext to store).
   * @param dek the raw 32-byte data key.
   */
  async wrapDek(dek: Uint8Array): Promise<string> {
    const plaintextB64 = base64Encode(dek);
    const body = JSON.stringify({ plaintext: plaintextB64 });
    const data = await this.transitCall("encrypt", body, "wrap");
    const ciphertext = data?.ciphertext;
    if (typeof ciphertext !== "string" || !ciphertext.startsWith("vault:")) {
      throw new OpenBaoError("transit/encrypt returned no ciphertext", "wrap");
    }
    return ciphertext;
  }

  /**
   * Unwrap a previously-wrapped DEK. Returns the raw 32-byte key.
   * @param wrapped the opaque `vault:v<n>:…` string from `wrapDek`.
   */
  async unwrapDek(wrapped: string): Promise<Uint8Array> {
    if (typeof wrapped !== "string" || !wrapped.startsWith("vault:")) {
      throw new OpenBaoError("malformed wrapped DEK", "unwrap");
    }
    const body = JSON.stringify({ ciphertext: wrapped });
    const data = await this.transitCall("decrypt", body, "unwrap");
    const plaintextB64 = data?.plaintext;
    if (typeof plaintextB64 !== "string") {
      throw new OpenBaoError("transit/decrypt returned no plaintext", "unwrap");
    }
    const dek = base64Decode(plaintextB64);
    if (dek.length !== 32) {
      throw new OpenBaoError("unwrapped DEK has unexpected length", "unwrap");
    }
    return dek;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * POST {addr}/v1/transit/{op}/{key} with the AppRole token, with exactly one
   * re-login+retry on a 403. Returns the `.data` object on success.
   */
  private async transitCall(
    op: "encrypt" | "decrypt",
    body: string,
    kind: string,
  ): Promise<Record<string, unknown>> {
    const path = `/v1/transit/${op}/${encodeURIComponent(this.transitKey)}`;
    // First attempt with a (possibly cached) token.
    let token = await this.getToken(false);
    let res = await this.httpPost(path, body, token, kind);
    if (res.status === 403) {
      // Token may have expired/been revoked between cache and use: re-login ONCE.
      this.cachedToken = undefined;
      token = await this.getToken(true);
      res = await this.httpPost(path, body, token, kind);
    }
    if (!res.ok) {
      // Coarse class only — never echo OpenBao's body (could carry context).
      throw new OpenBaoError(`transit/${op} failed (status ${res.status})`, kind);
    }
    const json = (await this.safeJson(res, kind)) as { data?: Record<string, unknown> };
    if (!json?.data) {
      throw new OpenBaoError(`transit/${op} returned no data`, kind);
    }
    return json.data;
  }

  /** Return a valid AppRole token, logging in if absent/expired (or forced). */
  private async getToken(forceRelogin: boolean): Promise<string> {
    if (
      !forceRelogin &&
      this.cachedToken &&
      this.now() < this.cachedTokenExpiresAt - TOKEN_EXPIRY_SKEW_MS
    ) {
      return this.cachedToken;
    }
    const res = await this.httpPost(
      "/v1/auth/approle/login",
      JSON.stringify({ role_id: this.roleId, secret_id: this.secretId }),
      undefined,
      "login",
    );
    if (!res.ok) {
      throw new OpenBaoError(`AppRole login failed (status ${res.status})`, "login");
    }
    const json = (await this.safeJson(res, "login")) as {
      auth?: { client_token?: string; lease_duration?: number };
    };
    const tok = json?.auth?.client_token;
    if (typeof tok !== "string" || !tok) {
      throw new OpenBaoError("AppRole login returned no client_token", "login");
    }
    const leaseSecs =
      typeof json.auth?.lease_duration === "number" && json.auth.lease_duration > 0
        ? json.auth.lease_duration
        : 60; // conservative floor
    this.cachedToken = tok;
    this.cachedTokenExpiresAt = this.now() + leaseSecs * 1000;
    return tok;
  }

  /** A single POST with a hard timeout. Returns the Response (never throws on
   *  non-2xx — the caller inspects `.status` so it can do the 403 retry). */
  private async httpPost(
    path: string,
    body: string,
    token: string | undefined,
    kind: string,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers["X-Vault-Token"] = token;
      return await this.doFetch(`${this.addr}${path}`, {
        method: "POST",
        headers,
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      // TEMP diagnostic (revert after): surface the REAL error + the target URL
      // so we can see exactly what the fetch is failing on, and confirm which
      // OPENBAO_ADDR is in effect. The URL is the configured host + a fixed path.
      const timedOut = e instanceof Error && e.name === "AbortError";
      const real =
        e instanceof Error
          ? `${e.name}: ${e.message}${
              (e as { cause?: unknown }).cause
                ? ` | cause: ${String((e as { cause?: unknown }).cause)}`
                : ""
            }`
          : String(e);
      throw new OpenBaoError(
        timedOut
          ? `request to ${this.addr}${path} timed out`
          : `request to ${this.addr}${path} failed — ${real}`,
        timedOut ? "timeout" : kind,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeJson(res: Response, kind: string): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new OpenBaoError("OpenBao returned non-JSON", kind);
    }
  }
}

// ── base64 (standard, not url) — transit expects/returns standard base64 ──────
function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a transit client from the Worker env (the production entry point). */
export function openBaoFromEnv(env: {
  OPENBAO_ADDR: string;
  OPENBAO_ROLE_ID: string;
  OPENBAO_SECRET_ID: string;
  OPENBAO_TRANSIT_KEY: string;
}): OpenBaoTransit {
  return new OpenBaoTransit({
    addr: env.OPENBAO_ADDR,
    roleId: env.OPENBAO_ROLE_ID,
    secretId: env.OPENBAO_SECRET_ID,
    transitKey: env.OPENBAO_TRANSIT_KEY,
  });
}
