/**
 * OAuth discovery-metadata shape + PKCE hardening.
 *
 * Asserts the two well-known documents a remote MCP client (Claude.ai / ChatGPT)
 * reads to bootstrap OAuth:
 *   • RFC 9728  /.well-known/oauth-protected-resource   → resource + AS pointer
 *   • RFC 8414  /.well-known/oauth-authorization-server → endpoints + S256 + CIMD
 * and that PKCE is locked to S256 (no "plain" advertised) — the `allowPlainPKCE:
 * false` override taking effect.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { method: "GET" }),
    env as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const json = res.status === 200 ? await res.json() : null;
  return { status: res.status, json };
}

describe("RFC 9728 — protected-resource metadata", () => {
  it("advertises the resource identifier and authorization server", async () => {
    const { status, json } = await getJson("/.well-known/oauth-protected-resource");
    expect(status).toBe(200);
    // resource MUST be present (the canonical /mcp URL from resourceMetadata).
    expect(typeof json.resource).toBe("string");
    expect(json.resource).toContain("/mcp");
    // authorization_servers MUST point clients at the AS (this same origin).
    expect(Array.isArray(json.authorization_servers)).toBe(true);
    expect(json.authorization_servers.length).toBeGreaterThan(0);
    // scopes advertised.
    expect(json.scopes_supported).toContain("mcp");
  });
});

describe("RFC 8414 — authorization-server metadata", () => {
  it("exposes endpoints, S256-only PKCE, DCR and CIMD support", async () => {
    const { status, json } = await getJson("/.well-known/oauth-authorization-server");
    expect(status).toBe(200);

    // Core endpoints.
    expect(typeof json.issuer).toBe("string");
    expect(json.authorization_endpoint).toContain("/authorize");
    expect(json.token_endpoint).toContain("/token");
    // DCR endpoint (RFC 7591) advertised.
    expect(json.registration_endpoint).toContain("/register");

    // PKCE: S256 present, "plain" ABSENT (allowPlainPKCE:false).
    expect(json.code_challenge_methods_supported).toContain("S256");
    expect(json.code_challenge_methods_supported).not.toContain("plain");

    // No implicit flow in the advertised grant/response types.
    if (json.response_types_supported) {
      expect(json.response_types_supported).not.toContain("token");
    }

    // CIMD advertised (requires the global_fetch_strictly_public compat flag,
    // set in wrangler.toml / vitest miniflare). If this is false here, the compat
    // flag is not active in the test runtime — that's the thing to fix.
    expect(json.client_id_metadata_document_supported).toBe(true);
  });
});
