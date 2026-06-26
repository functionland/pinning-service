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
}

// `__Host-` prefix: the browser enforces Secure + Path=/ + NO Domain attribute,
// which prevents a sibling subdomain from injecting/overwriting this cookie
// (cookie-tossing / fixation hardening on the upstream-OAuth state).
const STATE_COOKIE = "__Host-fula_mcp_oauth_state";
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
  const props = { email, name, userId };

  // DOWNSCOPE: the library advertises scopes_supported but does NOT enforce it at
  // grant time, so a client requesting `scope=mcp admin` would otherwise get
  // `admin` minted. Intersect the requested scope with what we're willing to
  // grant; if the client asked for nothing valid, default to ["mcp"].
  const requested = parsed.authRequest.scope ?? [];
  const grantedScope = requested.filter((s) => GRANTABLE_SCOPES.has(s));
  const scope = grantedScope.length > 0 ? grantedScope : ["mcp"];

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: parsed.authRequest,
    userId,
    // Unencrypted grant metadata — keep PII-free (it is enumerable in KV).
    metadata: { provider: "google" },
    scope,
    props,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      // Clear the now-spent state cookie.
      "Set-Cookie": clearCookieHeader(STATE_COOKIE),
    },
  });
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

async function sealCookie(plaintext: string, keyHex: string): Promise<string> {
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

async function openCookie(sealed: string, keyHex: string): Promise<string> {
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
