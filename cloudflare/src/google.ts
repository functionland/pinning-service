/**
 * Upstream IdP federation — Google (H1).
 *
 * This is the OAuthProvider `defaultHandler`: it owns every non-API route, most
 * importantly the user-facing authorization UI. We do NOT show our own login
 * page; we broker the user's existing Fula identity by bouncing them through
 * Google's OAuth, then translate the verified Google identity into an MCP grant
 * via `env.OAUTH_PROVIDER.completeAuthorization`.
 *
 * Flow:
 *   GET /authorize           (client → us; the MCP client's OAuth 2.1 authorize)
 *     → parseAuthRequest()   capture the inbound MCP AuthRequest (PKCE, resource…)
 *     → stash it in a short-lived ENCRYPTED state cookie
 *     → 302 to Google's consent screen
 *   GET /callback?code&state (Google → us)
 *     → exchange `code` at Google's token endpoint for an id_token
 *     → VERIFY the id_token (jose, against Google's JWKS: iss/aud/exp/sig)
 *     → email = verified claim;  userId = SHA-256(lowercased email) hex
 *     → completeAuthorization({ userId, props:{ email, name, userId }, … })
 *     → 302 back to the MCP client's redirect_uri with our auth code
 *
 * Apple is a deliberate sibling: a second `case` in `/authorize` keyed on an
 * `idp` hint plus an `/callback/apple` verifier (apple uses the same id_token
 * shape; only the issuer, JWKS URL and the form-POST callback differ). Left as a
 * TODO for H1 — the structure here is provider-agnostic on purpose.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { emailToUserId } from "./userId.js";
import {
  COLLAB_CONNECTION_ROUTE,
  COLLAB_BUNDLE_ROUTE,
  handleCollabConnection,
  handleCollabBundle,
  loadOrGenerateMcpIdentity,
  type CapabilityEnv,
} from "./capability.js";

/** Env shape the federation handler needs (subset of the Worker env). The custody
 *  fields (CUSTODY_DB + OPENBAO_*) are required because this handler also owns the
 *  `/collab/*` connect routes. */
export interface FederationEnv extends CapabilityEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_AUTH_URL: string;
  GOOGLE_TOKEN_URL: string;
  GOOGLE_JWKS_URL: string;
  /** 32-byte hex; encrypts the in-flight authorization-request state cookie. */
  COOKIE_ENCRYPTION_KEY: string;
  CANONICAL_ORIGIN: string;
  /** Kill-switch: set to "1"/"true" to skip the post-sign-in FULA-id interstitial
   *  and revert to the direct redirect (a dashboard var flip, no code redeploy) if
   *  it ever trips an OAuth client's handshake in production. Unset ⇒ interstitial on. */
  DISABLE_IDENTITY_INTERSTITIAL?: string;
}

// `__Host-` prefix: the browser enforces Secure + Path=/ + NO Domain attribute,
// which prevents a sibling subdomain from injecting/overwriting this cookie
// (cookie-tossing / fixation hardening on the upstream-OAuth state).
const STATE_COOKIE = "__Host-fula_mcp_oauth_state";
// Short-lived cookie carrying the sealed AuthRequest across the id-display
// interstitial, so the OAuth code is minted only on the user's "Finish" POST
// (handleCallbackContinue) — a slow copy can then NEVER expire the code. Same
// __Host- hardening (Secure + Path=/ + no Domain) as STATE_COOKIE.
const CONTINUE_COOKIE = "__Host-fula_mcp_continue";
/** Cap the extra identity lookup so a slow/broken custody path cannot hang the
 *  post-login page; on timeout we fall through to direct completion. */
const IDENTITY_RENDER_TIMEOUT_MS = 4000;
/** Skip the interstitial if the sealed continue cookie would approach the browser
 *  ~4 KB per-cookie ceiling (an oversized cookie is silently dropped → the Finish
 *  POST would find nothing). Fall through to direct completion instead. */
const MAX_CONTINUE_COOKIE_BYTES = 3800;
const GOOGLE_SCOPES = "openid email profile";
/** The OAuth scopes this AS is willing to grant (mirrors index.ts). The library
 *  advertises these but does NOT downscope at grant time, so we intersect the
 *  client's requested scope against this set ourselves (deny scope escalation). */
const GRANTABLE_SCOPES = new Set(["mcp"]);
const GOOGLE_ACCEPTED_ISS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

// Lazily-built, per-isolate cache of the Google JWKS fetcher. createRemoteJWKSet
// caches keys internally and refetches on unknown `kid`, so one per JWKS URL.
let googleJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let googleJwksUrl: string | undefined;
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  if (!googleJwks || googleJwksUrl !== url) {
    googleJwks = createRemoteJWKSet(new URL(url));
    googleJwksUrl = url;
  }
  return googleJwks;
}

/** The OAuthProvider `defaultHandler`. */
export const googleDefaultHandler = {
  async fetch(request: Request, env: FederationEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }
    if (url.pathname === "/callback/continue") {
      return handleCallbackContinue(request, env);
    }
    // The FxFiles → Worker collaboration CONNECT routes. Authenticated by a Worker
    // access token (Bearer), validated via the OAuth provider. `GET /collab/connection`
    // returns the connection's X25519 pubkey + FULA-id; `POST /collab/bundle` seals
    // the delivered bundle into D1 (envelope-encrypted, DEK wrapped by OpenBao).
    if (url.pathname === COLLAB_CONNECTION_ROUTE) {
      return handleCollabConnection(request, env as unknown as CapabilityEnv);
    }
    if (url.pathname === COLLAB_BUNDLE_ROUTE) {
      return handleCollabBundle(request, env as unknown as CapabilityEnv);
    }
    if (url.pathname === "/" || url.pathname === "") {
      // Tiny liveness page; never an auth surface.
      return new Response(
        "Fula hosted MCP server. Connect an MCP client to /mcp via OAuth.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};

// ── /authorize ───────────────────────────────────────────────────────────────
async function handleAuthorize(request: Request, env: FederationEnv): Promise<Response> {
  // Parse the inbound MCP client's OAuth 2.1 authorization request. This carries
  // the client's PKCE challenge and (if sent) the RFC 8707 `resource` indicator
  // that drives audience-binding of the eventual access token.
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return new Response("Invalid authorization request", { status: 400 });
  }
  if (!authRequest.clientId) {
    return new Response("Missing client_id", { status: 400 });
  }

  // Stash the ENTIRE AuthRequest (PKCE challenge, resource, state, redirect_uri…)
  // in an encrypted, signed, short-lived cookie so every field survives the
  // Google round-trip and is handed verbatim to completeAuthorization().
  const nonce = crypto.randomUUID();
  const statePayload = JSON.stringify({ authRequest, nonce });
  const sealed = await sealCookie(statePayload, env.COOKIE_ENCRYPTION_KEY);

  const redirectUri = `${env.CANONICAL_ORIGIN}/callback`;
  const googleUrl = new URL(env.GOOGLE_AUTH_URL);
  googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri", redirectUri);
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", GOOGLE_SCOPES);
  // We use our own encrypted cookie as the CSRF/state carrier; send the nonce as
  // Google's `state` so the callback can cross-check it against the cookie.
  googleUrl.searchParams.set("state", nonce);
  googleUrl.searchParams.set("access_type", "online");
  googleUrl.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: googleUrl.toString(),
      "Set-Cookie": cookieHeader(STATE_COOKIE, sealed),
    },
  });
}

// ── /callback ────────────────────────────────────────────────────────────────
async function handleCallback(request: Request, env: FederationEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return new Response(`Upstream OAuth error: ${oauthError}`, { status: 400 });
  }
  if (!code || !returnedState) {
    return new Response("Missing code/state", { status: 400 });
  }

  // Recover and verify the sealed state cookie.
  const cookie = readCookie(request, STATE_COOKIE);
  if (!cookie) {
    return new Response("Missing state cookie", { status: 400 });
  }
  let parsed: { authRequest: AuthRequest; nonce: string };
  try {
    const opened = await openCookie(cookie, env.COOKIE_ENCRYPTION_KEY);
    parsed = JSON.parse(opened);
  } catch {
    return new Response("Invalid state cookie", { status: 400 });
  }
  // CSRF: Google's returned `state` must equal the nonce we sealed.
  if (parsed.nonce !== returnedState) {
    return new Response("State mismatch", { status: 400 });
  }

  // Exchange the authorization code for tokens at Google.
  const redirectUri = `${env.CANONICAL_ORIGIN}/callback`;
  const tokenRes = await fetch(env.GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return new Response("Token exchange failed", { status: 502 });
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: string };
  if (!tokenJson.id_token) {
    return new Response("No id_token from Google", { status: 502 });
  }

  // VERIFY the id_token: signature (Google JWKS), issuer, audience (our client
  // id), expiry. jwtVerify throws on any failure → we reject.
  let email: string;
  let name: string | undefined;
  try {
    const { payload } = await jwtVerify(tokenJson.id_token, jwksFor(env.GOOGLE_JWKS_URL), {
      audience: env.GOOGLE_CLIENT_ID,
      // issuer accepts either of Google's two canonical issuer strings.
      issuer: [...GOOGLE_ACCEPTED_ISS],
    });
    // `azp` (authorized party) hardening: when Google sets it, it MUST be our
    // client id. This closes the case where `aud` is multi-valued — `aud` alone
    // would pass jwtVerify but the token might have been minted for a different
    // authorized party. (Single-aud tokens often omit azp; absent ⇒ aud check
    // already pinned it to GOOGLE_CLIENT_ID.)
    const azp = payload.azp;
    if (typeof azp === "string" && azp !== env.GOOGLE_CLIENT_ID) {
      return new Response("Google id_token azp mismatch", { status: 401 });
    }
    const claimEmail = payload.email;
    const verified = payload.email_verified;
    if (typeof claimEmail !== "string" || !claimEmail) {
      return new Response("Google id_token missing email", { status: 400 });
    }
    // FAIL CLOSED: require email_verified === true. An absent/false claim is NOT
    // trusted (stricter than legacy webui — correct posture for a fresh OAuth AS).
    if (verified !== true) {
      return new Response("Google email not verified", { status: 403 });
    }
    email = claimEmail.toLowerCase();
    name = typeof payload.name === "string" ? payload.name : undefined;
  } catch {
    return new Response("Invalid Google id_token", { status: 401 });
  }

  // Translate the verified Google identity into the Fula user_id, then complete
  // the MCP authorization. The grant's `userId` is the PSEUDONYMOUS hash (never
  // the raw email); the email lives only in the E2E-encrypted `props`.
  const userId = await emailToUserId(email);
  // Inject the OAuth client_id (stable per DCR client, server-authoritative,
  // validated non-empty at /authorize) into the grant props. The custody layer
  // keys per (user_id, client_id) so each connected AI (claude vs chatgpt) is a
  // DISTINCT, isolated identity — see src/custody.ts + mcp.ts resolveClientIdFromProps.
  const props = { email, name, userId, clientId: parsed.authRequest.clientId };

  // DOWNSCOPE: the library advertises scopes_supported but does NOT enforce it at
  // grant time, so a client requesting `scope=mcp admin` would otherwise get
  // `admin` minted. Intersect the requested scope with what we're willing to
  // grant; if the client asked for nothing valid, default to ["mcp"].
  const requested = parsed.authRequest.scope ?? [];
  const grantedScope = requested.filter((s) => GRANTABLE_SCOPES.has(s));
  const scope = grantedScope.length > 0 ? grantedScope : ["mcp"];

  // ── Show the AI's Fula id, then finish (best-effort) ────────────────────────
  // Render an interstitial that shows THIS connection's FULA-… id (its X25519
  // public key) with a Copy button, so the user can grab it WITHOUT asking the
  // AI. The OAuth code is minted only when the user continues (POST
  // /callback/continue) — the SAME "seal the AuthRequest, completeAuthorization
  // in a later request" pattern this callback already uses across the Google hop
  // — so a slow copy can NEVER expire the code.
  //
  // HARD RULE: login must never break. ANY failure here (custody/OpenBao down,
  // timeout, render/seal error) falls through to the direct completion below,
  // which is exactly the original behavior.
  // Kill-switch: DISABLE_IDENTITY_INTERSTITIAL=1 instantly reverts to the direct
  // redirect (dashboard var flip, no redeploy) if the interstitial ever trips a
  // client's OAuth handshake in production.
  const interstitialOff =
    env.DISABLE_IDENTITY_INTERSTITIAL === "1" || env.DISABLE_IDENTITY_INTERSTITIAL === "true";
  try {
    const idRes = interstitialOff
      ? null
      : await withTimeout(
          loadOrGenerateMcpIdentity(env as unknown as CapabilityEnv, userId, parsed.authRequest.clientId),
          IDENTITY_RENDER_TIMEOUT_MS,
        );
    if (idRes && idRes.mcpFulaId) {
      // Seal {authRequest, userId, email, name, scope} for the Finish POST. The
      // blob is AES-GCM CIPHERTEXT (email/name are NOT readable from a stolen
      // cookie), HttpOnly + Secure + __Host- + SameSite=Lax + Max-Age=600. props
      // is kept byte-identical to the direct path so the minted grant is unchanged.
      const continueState = JSON.stringify({ authRequest: parsed.authRequest, userId, email, name, scope });
      const sealed = await sealCookie(continueState, env.COOKIE_ENCRYPTION_KEY);
      // Never-break guard: a cookie near the browser ~4 KB ceiling is silently
      // dropped → the Finish POST would see nothing. If too large, skip the
      // interstitial and complete directly (falls through below).
      if (sealed.length <= MAX_CONTINUE_COOKIE_BYTES) {
        const nonce = randomNonceHex();
        const headers = new Headers();
        headers.set("content-type", "text/html; charset=utf-8");
        headers.set("cache-control", "no-store");
        headers.set("referrer-policy", "no-referrer");
        headers.set("x-content-type-options", "nosniff");
        headers.set("x-frame-options", "DENY");
        headers.set(
          "content-security-policy",
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        );
        // Two Set-Cookie: clear the spent state cookie, set the short-lived continue
        // cookie. CSRF on POST /callback/continue is blocked by SameSite=Lax — this
        // cookie MUST stay SameSite=Lax (never None) for that defense to hold.
        headers.append("Set-Cookie", clearCookieHeader(STATE_COOKIE));
        headers.append("Set-Cookie", cookieHeader(CONTINUE_COOKIE, sealed));
        return new Response(renderIdentityInterstitial(idRes.mcpFulaId, nonce), { status: 200, headers });
      }
    }
  } catch (e) {
    // fall through — NEVER block login on the id-display path
    console.warn("[mcp/callback] identity interstitial skipped, completing directly:", (e as Error)?.message);
  }

  // Direct completion (no id shown): the original, always-safe path.
  return completeAndRedirect(env, parsed.authRequest, userId, scope, props, STATE_COOKIE);
}

// ── /callback/continue — finish OAuth after the id interstitial ──────────────
// The interstitial's "Finish connecting" form POSTs here. We recover the sealed
// AuthRequest from the continue cookie and mint the code NOW (fresh), so the copy
// dwell time is irrelevant. A missing/expired/corrupt cookie yields a graceful,
// retryable "reconnect" page — never a 500, and login stays recoverable.
export async function handleCallbackContinue(request: Request, env: FederationEnv): Promise<Response> {
  const cookie = readCookie(request, CONTINUE_COOKIE);
  if (!cookie) return reconnectResponse();
  let parsed: { authRequest: AuthRequest; userId: string; email: string; name?: string; scope: string[] };
  try {
    parsed = JSON.parse(await openCookie(cookie, env.COOKIE_ENCRYPTION_KEY));
  } catch {
    return reconnectResponse();
  }
  if (!parsed || !parsed.authRequest || !parsed.authRequest.clientId || !parsed.userId) {
    return reconnectResponse();
  }
  const scope = Array.isArray(parsed.scope) && parsed.scope.length > 0 ? parsed.scope : ["mcp"];
  const props = {
    email: parsed.email,
    name: parsed.name,
    userId: parsed.userId,
    clientId: parsed.authRequest.clientId,
  };
  try {
    return await completeAndRedirect(env, parsed.authRequest, parsed.userId, scope, props, CONTINUE_COOKIE);
  } catch (e) {
    console.warn("[mcp/callback/continue] completeAuthorization failed:", (e as Error)?.message);
    return reconnectResponse();
  }
}

// Mint the grant + code and 302 back to the MCP client, clearing `clearCookie`.
// Shared by the direct callback path and the continue path.
export async function completeAndRedirect(
  env: FederationEnv,
  authRequest: AuthRequest,
  userId: string,
  scope: string[],
  props: { email: string; name?: string; userId: string; clientId: string },
  clearCookie: string,
): Promise<Response> {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId,
    // Unencrypted grant metadata — keep PII-free (it is enumerable in KV).
    metadata: { provider: "google" },
    scope,
    props,
  });
  const headers = new Headers();
  headers.set("Location", redirectTo);
  // The auth code rides in the Location URL; no-referrer keeps it out of the
  // Referer header on the hop to the MCP client's redirect_uri.
  headers.set("Referrer-Policy", "no-referrer");
  headers.append("Set-Cookie", clearCookieHeader(clearCookie));
  return new Response(null, { status: 302, headers });
}

/** Race a promise against a timeout (rejects on timeout; caller falls through).
 *  Swallows a late rejection of `p` after the timeout won (so it never surfaces as
 *  an unhandled rejection) and clears the timer once the race settles. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  p.catch(() => {});
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

/** 16 random bytes as hex — a CSP script nonce (hex avoids any base64 charset edge). */
function randomNonceHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Post-sign-in pages (self-contained; no external resources) ───────────────
/** Interstitial showing the AI's FULA-id with Copy + a "Finish connecting" form.
 *  `nonce` authorizes the single inline <script> under the page CSP. */
export function renderIdentityInterstitial(fulaId: string, nonce: string): string {
  const id = escapeHtml(fulaId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FxFiles — AI connected</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 16px; }
  .card { max-width: 520px; width: 100%; background: #131a22; border: 1px solid #22303c; border-radius: 14px; padding: 28px; box-shadow: 0 8px 40px rgba(0,0,0,.35); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #9fb0c0; line-height: 1.5; font-size: 14px; margin: 8px 0; }
  .idrow { display: flex; gap: 8px; margin: 18px 0 6px; }
  #fid { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; padding: 12px; border-radius: 10px; border: 1px solid #2b3a49; background: #0b0f14; color: #e6edf3; }
  button { font: inherit; font-size: 14px; border: 0; border-radius: 10px; padding: 12px 16px; cursor: pointer; }
  .copy { background: #1f6feb; color: #fff; }
  .finish { background: #06B597; color: #05231d; font-weight: 700; width: 100%; margin-top: 18px; padding: 14px; }
  .note { background: #0e1620; border: 1px solid #22303c; border-radius: 10px; padding: 12px; margin-top: 14px; font-size: 13px; color: #9fb0c0; }
  .fine { font-size: 12px; color: #6b7f90; }
</style>
</head>
<body>
  <div class="card">
    <h1>✅ Your AI is connected to FxFiles</h1>
    <p>Copy this AI's Fula identity, then in FxFiles open <strong>Share with AI Agent</strong> and paste it to grant this AI access to a collaboration group.</p>
    <div class="idrow">
      <input id="fid" value="${id}" readonly spellcheck="false" aria-label="Your AI's Fula identity">
      <button class="copy" id="copyBtn" type="button">Copy</button>
    </div>
    <div class="note">Didn't copy it now? You can ask your AI <strong>"What is my Fula id?"</strong> anytime and it will show this same id again.</div>
    <form method="POST" action="/callback/continue">
      <button class="finish" type="submit">Finish connecting →</button>
    </form>
    <p class="fine">Click <strong>Finish connecting</strong> to return to your AI and complete setup. This page also finishes automatically after a few seconds.</p>
  </div>
  <script nonce="${nonce}">
    (function () {
      var btn = document.getElementById('copyBtn');
      var fid = document.getElementById('fid');
      btn.addEventListener('click', function () {
        fid.focus();
        fid.select();
        try { navigator.clipboard.writeText(fid.value); } catch (e) {}
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
      });
      // Anti-abandonment safety net: auto-finish so a user who copies and switches
      // to FxFiles still completes the connection. Short enough to stay well inside
      // any OAuth client's popup wait. A "submitted" guard (survives bfcache) makes
      // the manual Finish and the auto-submit mutually exclusive - no double POST.
      var form = document.forms[0];
      var submitted = false;
      var timer = setTimeout(function () { if (form && !submitted) { submitted = true; form.submit(); } }, 12000);
      if (form) form.addEventListener('submit', function (e) {
        if (submitted) { e.preventDefault(); return; }
        submitted = true;
        clearTimeout(timer);
      });
    })();
  </script>
</body>
</html>`;
}

/** Shown only if the continue cookie was lost/expired — graceful + retryable. */
export function renderReconnectPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FxFiles — please reconnect</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 16px; }
  .card { max-width: 460px; width: 100%; background: #131a22; border: 1px solid #22303c; border-radius: 14px; padding: 28px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #9fb0c0; line-height: 1.5; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>This connection timed out</h1>
    <p>Your session expired before finishing. Please remove and re-add the FxFiles connector in your AI, then sign in again — your files were not affected.</p>
  </div>
</body>
</html>`;
}

function reconnectResponse(): Response {
  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.append("Set-Cookie", clearCookieHeader(CONTINUE_COOKIE));
  return new Response(renderReconnectPage(), { status: 200, headers });
}

// ── Encrypted state cookie (AES-GCM with the configured key) ─────────────────
// The cookie carries the in-flight AuthRequest across the Google detour. It is
// confidential (PKCE challenge / resource) and integrity-protected (GCM tag), so
// a client cannot tamper with the authorization parameters mid-flight.

function keyBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("COOKIE_ENCRYPTION_KEY must be 32-byte hex (64 chars)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function importKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes(hex), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealCookie(plaintext: string, keyHex: string): Promise<string> {
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64urlEncode(packed);
}

export async function openCookie(sealed: string, keyHex: string): Promise<string> {
  const key = await importKey(keyHex);
  const packed = b64urlDecode(sealed);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ── Cookie + base64url helpers ───────────────────────────────────────────────
function cookieHeader(name: string, value: string): string {
  // 600s is ample for the interactive Google round-trip; HttpOnly + Secure +
  // SameSite=Lax so it survives the top-level redirect back from Google.
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}
function clearCookieHeader(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
