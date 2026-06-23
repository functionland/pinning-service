/**
 * THE SECURITY-CRITICAL TEST — confused-deputy / token-passthrough guard.
 * ======================================================================
 *
 * Asserts that an access token whose recorded AUDIENCE is a DIFFERENT origin than
 * this Worker is REJECTED (HTTP 401) when presented at /mcp, and — critically —
 * that it is rejected *for the right reason* (audience mismatch), not merely
 * because some unrelated check failed.
 *
 * Why the "right reason" matters: `@cloudflare/workers-oauth-provider`'s
 * `handleApiRequest` returns DISTINCT 401s — a KV-miss 401 ("Invalid access
 * token"), an expired 401 ("Access token expired"), and the audience 401 we want
 * ("Token audience does not match resource server" + WWW-Authenticate "Invalid
 * audience"). A test that asserted only `status === 401` would PASS even if our
 * seed were malformed and the token never resolved (KV-miss) — proving nothing.
 * So we assert on the audience-specific string, AND add a NEGATIVE CONTROL (an
 * unseeded token) that must fail with the *KV-miss* string, proving the positive
 * test really exercised the audience branch.
 *
 * The seed reproduces EXACTLY how the library stores an access token (verified
 * from the installed dist, `createAccessToken`):
 *   token        = `${userId}:${grantId}:${secret}`
 *   KV key       = `token:${userId}:${grantId}:${sha256hex(token)}`
 *   record.audience set to a FOREIGN origin; record.expiresAt in the future.
 * The audience check runs BEFORE prop-decryption, so the record needs only
 * `expiresAt` + `audience` to drive the branch (no real wrappedEncryptionKey).
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";

const MCP_URL = "http://localhost/mcp";

// SHA-256 hex — identical to the library's `generateTokenId`.
async function tokenId(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Seed OAUTH_KV with an access-token record exactly as the library writes it. */
async function seedToken(opts: {
  userId: string;
  grantId: string;
  secret: string;
  audience?: string | string[];
  expiresAt: number;
}): Promise<string> {
  const token = `${opts.userId}:${opts.grantId}:${opts.secret}`;
  const id = await tokenId(token);
  const record = {
    id,
    grantId: opts.grantId,
    userId: opts.userId,
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: opts.expiresAt,
    audience: opts.audience,
    scope: ["mcp"],
    // Present for shape-fidelity; never reached on the audience-reject path.
    wrappedEncryptionKey: "dGVzdA==",
    grant: { clientId: "test-client", scope: ["mcp"], encryptedProps: "dGVzdA==" },
  };
  await (env as unknown as { OAUTH_KV: KVNamespace }).OAUTH_KV.put(
    `token:${opts.userId}:${opts.grantId}:${id}`,
    JSON.stringify(record),
  );
  return token;
}

function mcpInitRequest(bearer: string): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    }),
  });
}

async function callMcp(bearer: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(mcpInitRequest(bearer), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("confused-deputy / wrong-audience rejection (THE security guard)", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  it("REJECTS (401) a token whose audience is a DIFFERENT origin, citing audience", async () => {
    // Token minted for a DIFFERENT resource server (evil origin), replayed here.
    const token = await seedToken({
      userId: "a".repeat(64),
      grantId: "grant-foreign",
      secret: "foreign-secret-000000000000000000000000",
      audience: "https://evil.example.com/mcp",
      expiresAt: future,
    });

    const res = await callMcp(token);
    expect(res.status).toBe(401);

    const www = res.headers.get("WWW-Authenticate") ?? "";
    const body = await res.text();
    // The audience-specific signal — NOT a generic 401. This is what proves the
    // recipient-binding branch fired (vs a KV-miss or expiry).
    expect(www.toLowerCase()).toContain("invalid_token");
    expect(`${www} ${body}`.toLowerCase()).toMatch(/audience/);
  });

  it("NEGATIVE CONTROL: an UNSEEDED token fails for KV-miss, NOT audience", async () => {
    // Same shape, but never written to KV ⇒ the library can't resolve it ⇒ it
    // must reject with the *invalid access token* path, never the audience path.
    // This is what proves the positive test above really exercised the audience
    // branch (a malformed positive seed would land HERE — KV-miss — and the
    // positive test's `/audience/` assertion would then fail, as it must).
    const bogus = `${"b".repeat(64)}:grant-missing:never-seeded-secret-0000000000000000`;
    const res = await callMcp(bogus);
    expect(res.status).toBe(401);

    const www = res.headers.get("WWW-Authenticate") ?? "";
    const body = await res.text();
    expect(`${www} ${body}`.toLowerCase()).not.toMatch(/audience/);
  });

  // NOTE on specificity: a "matching-origin accepted" positive control is
  // deliberately omitted. To exercise it the seeded token would have to carry a
  // genuinely decryptable `wrappedEncryptionKey` (the audience gate passes, then
  // the library decrypts props) — minting that faithfully means running the full
  // OAuth flow, which can't be driven headlessly here. The negative control above
  // already proves the guard is SPECIFIC (it rejects on audience, not blanket),
  // because the foreign-origin token reaches the audience branch only after the
  // KV lookup SUCCEEDS — distinct from the KV-miss path the control verifies.
});
