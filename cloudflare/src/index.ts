/**
 * Fula hosted (remote) MCP server — Cloudflare Worker entry point. H1 skeleton.
 *
 * ARCHITECTURE (decided; built on deep research)
 * ──────────────────────────────────────────────
 * This single Worker is BOTH the OAuth 2.1 Authorization Server AND the Resource
 * Server for the Model Context Protocol, using @cloudflare/workers-oauth-provider
 * (the canonical Cloudflare remote-MCP pattern). It does not run its own login UI;
 * it FEDERATES up to Google (the user's existing Fula identity — see ./google.ts),
 * then issues its own opaque OAuth tokens to the MCP client (Claude.ai / ChatGPT).
 *
 *   MCP client ──OAuth 2.1 (PKCE S256, resource=…)──►  this Worker (AS)
 *                                                          │  federates ▼
 *                                                       Google (upstream IdP)
 *   MCP client ──Bearer access_token──►  this Worker (RS) ──► /mcp tool dispatch
 *
 * (An alternative split — Worker=RS only, pinning-webui=AS — is viable but is NOT
 * the architecture chosen for this build. See the PR description.)
 *
 * The library serves the discovery metadata automatically:
 *   • RFC 9728  GET /.well-known/oauth-protected-resource   (resource server)
 *   • RFC 8414  GET /.well-known/oauth-authorization-server (authorization server)
 * and enforces, on every /mcp request, that a token whose recorded audience does
 * NOT match this server's origin is REJECTED 401 (the confused-deputy guard —
 * see the test in test/audience.test.ts).
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { googleDefaultHandler } from "./google.js";
import { mcpApiHandler, MCP_ROUTE } from "./mcp.js";

/** Worker bindings (vars/secrets from wrangler.toml + .dev.vars + secrets). */
export interface Env {
  /** Injected by the OAuth provider before a handler runs. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** KV store the provider uses for tokens/grants/clients. */
  OAUTH_KV: KVNamespace;
  /** Canonical deployed origin, e.g. https://fula-mcp.fx.land. */
  CANONICAL_ORIGIN: string;
  /** Google OAuth Web client id (reuse the Fula stack's). Secret/var. */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth Web client secret. Secret. */
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_AUTH_URL: string;
  GOOGLE_TOKEN_URL: string;
  GOOGLE_JWKS_URL: string;
  /** 32-byte hex; encrypts the upstream-OAuth state cookie. Secret. */
  COOKIE_ENCRYPTION_KEY: string;
}

/** OAuth scope(s) this server understands. The stub exposes a single read scope. */
const SCOPES_SUPPORTED = ["mcp"];

/** The handler shape the OAuth provider accepts for api/default handlers. */
type OAuthProviderHandler = ExportedHandler<Env> & {
  fetch: NonNullable<ExportedHandler<Env>["fetch"]>;
};

/**
 * Build the OAuthProvider. Factory (not a module-level singleton) so a test can
 * construct it with a per-test CANONICAL_ORIGIN if needed; the default export
 * below is the production instance.
 */
export function buildOAuthProvider(canonicalOrigin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    // ── Resource (API) surface: the MCP Streamable-HTTP endpoint ──────────────
    apiRoute: MCP_ROUTE, // "/mcp"
    // The handlers are plain ExportedHandlers; they read a structural subset of
    // Env (mcp ignores env; google reads the Google/cookie vars). Cast to the
    // provider's Env-parameterised handler type — the runtime env is a superset.
    apiHandler: mcpApiHandler as unknown as OAuthProviderHandler,
    // ── Everything else (authorize UI, callback, root) → Google federation ────
    defaultHandler: googleDefaultHandler as unknown as OAuthProviderHandler,

    // ── OAuth endpoints the library implements ───────────────────────────────
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // RFC 7591 Dynamic Client Registration — Claude.ai / ChatGPT register via DCR.
    clientRegistrationEndpoint: "/register",

    // ── Security-critical hardening ──────────────────────────────────────────
    // PKCE: the library DEFAULTS allowPlainPKCE to TRUE. Force S256-only — with
    // this false, code_challenge_methods_supported advertises ONLY ["S256"] and
    // the token endpoint rejects a `plain` verifier.
    allowPlainPKCE: false,
    // CIMD (Client ID Metadata Document, https URL client_ids). Claude.ai/ChatGPT
    // increasingly use this alongside DCR. Effective ONLY with the
    // `global_fetch_strictly_public` compatibility flag (SSRF hardening) — set in
    // wrangler.toml; without it the metadata advertises false.
    clientIdMetadataDocumentEnabled: true,
    // OAuth 2.1: no implicit flow (this is the library default; pinned explicitly).
    allowImplicitFlow: false,

    scopesSupported: SCOPES_SUPPORTED,

    // ── RFC 9728 protected-resource metadata ─────────────────────────────────
    // `resource` is the canonical identifier MCP clients echo back as the RFC 8707
    // `resource` indicator — which is what makes the issued access token
    // AUDIENCE-BOUND to THIS server, so a cross-origin replay is rejected. It MUST
    // equal the deployed /mcp URL at H4.
    resourceMetadata: {
      resource: `${canonicalOrigin}${MCP_ROUTE}`,
      authorization_servers: [canonicalOrigin],
      scopes_supported: SCOPES_SUPPORTED,
    },
  });
}

/**
 * Canonical-host guard (belt-and-suspenders). The library's audience check is
 * CONDITIONAL on the token carrying an audience (i.e. the client sent a resource
 * indicator). If a Worker is reachable at multiple hostnames (e.g. the
 * *.workers.dev preview AND the custom domain), an UNBOUND token could otherwise
 * be replayed at a non-canonical host. We refuse MCP traffic on any origin that
 * is not the configured canonical one, so the resource identity is unambiguous.
 * (Discovery + OAuth endpoints stay open so clients can still bootstrap; only the
 * token-bearing /mcp surface is host-pinned.)
 */
function enforceCanonicalHost(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(MCP_ROUTE)) return null;
  // Allow if CANONICAL_ORIGIN is unset (local dev convenience) or matches.
  if (!env.CANONICAL_ORIGIN) return null;
  let canonical: URL;
  try {
    canonical = new URL(env.CANONICAL_ORIGIN);
  } catch {
    return null;
  }
  // localhost / 127.0.0.1 are always allowed so `wrangler dev` + tests work.
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
  if (url.host !== canonical.host) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const blocked = enforceCanonicalHost(request, env);
    if (blocked) return blocked;
    const provider = buildOAuthProvider(env.CANONICAL_ORIGIN || new URL(request.url).origin);
    return provider.fetch(request, env, ctx);
  },
};
