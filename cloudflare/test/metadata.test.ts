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

async function getStatus(path: string): Promise<number> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { method: "GET" }),
    env as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res.status;
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

describe("PKCE S256 is ENFORCED at /authorize (not just advertised)", () => {
  // These exercise the actual rejection path in the library's parseAuthRequest
  // (the plain-PKCE / implicit-flow guards run BEFORE client lookup), surfaced by
  // our defaultHandler as a 4xx. This is the runtime counterpart to the metadata
  // assertions above — the task lists "PKCE-plain rejected" as a SEPARATE check.
  const base =
    "/authorize?response_type=code&client_id=test-client" +
    "&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=xyz" +
    "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("REJECTS code_challenge_method=plain", async () => {
    // allowPlainPKCE:false ⇒ parseAuthRequest throws ⇒ handler returns 400.
    const status = await getStatus(`${base}&code_challenge_method=plain`);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it("REJECTS an OMITTED code_challenge_method (defaults to plain)", async () => {
    // The library defaults an absent method to "plain" — so omitting it must ALSO
    // be rejected. (An S256 client therefore MUST send code_challenge_method=S256.)
    const status = await getStatus(base);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it("REJECTS the implicit flow (response_type=token)", async () => {
    // allowImplicitFlow:false ⇒ parseAuthRequest throws on response_type=token.
    const implicit =
      "/authorize?response_type=token&client_id=test-client" +
      "&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=xyz" +
      "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" +
      "&code_challenge_method=S256";
    const status = await getStatus(implicit);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});
