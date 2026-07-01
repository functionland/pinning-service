/**
 * S3 — Worker wiring: service-auth minter, by-pubkey bundle fetch (C2), and the
 * fula_identity tool (C3). Runs WITHOUT a live OpenBao via a deterministic mock
 * (mirrors capability-seam.test.ts), so the seal/open + the by-pubkey fetch wiring
 * are exercised locally. The FULL happy path (a real v5 ShareToken link-secret
 * recovery on a 200 bundle) is E2E-gated at S5/S6; here we assert the request
 * shape (by-pubkey URL + service-auth header) + the 404→null contract.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

// ── Mock ONLY the OpenBao transit factory — deterministic (same as the seam test) ──
vi.mock("../src/openbao.js", () => {
  function b64encode(bytes: Uint8Array): string {
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin);
  }
  function b64decode(s: string): Uint8Array {
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
  const mockBao = {
    async wrapDek(dek: Uint8Array): Promise<string> { return `vault:mock:${b64encode(dek)}`; },
    async unwrapDek(wrapped: string): Promise<Uint8Array> {
      if (typeof wrapped !== "string" || !wrapped.startsWith("vault:mock:")) throw new Error("mock unwrap: not mock-wrapped");
      const dek = b64decode(wrapped.slice("vault:mock:".length));
      if (dek.length !== 32) throw new Error("mock unwrap: bad DEK length");
      return dek;
    },
  };
  return { openBaoFromEnv: () => mockBao, OpenBaoTransit: class {}, OpenBaoError: class extends Error {} };
});

import { env } from "cloudflare:test";
import {
  mintServiceAuthHeader,
  loadCollabSession,
  loadOrGenerateMcpIdentity,
  type CapabilityEnv,
} from "../src/capability.js";
import { buildServer, MCP_ROUTE } from "../src/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { emailToUserId } from "../src/userId.js";

function plainEnv(): CapabilityEnv {
  return env as unknown as CapabilityEnv;
}
function envWithSvc(): CapabilityEnv {
  return {
    ...(env as unknown as Record<string, unknown>),
    FULA_WEBUI_BASE: "https://cloud.fx.land",
    FULA_PIN_SERVICE_SECRET: "svc-secret-for-s3-tests",
  } as unknown as CapabilityEnv;
}

beforeAll(async () => {
  const d1 = env.CUSTODY_DB as unknown as { exec(q: string): Promise<unknown> };
  await d1.exec("DROP TABLE IF EXISTS mcp_capabilities");
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_capabilities (user_id TEXT NOT NULL, client_id TEXT NOT NULL, record_id TEXT NOT NULL, capability_ciphertext BLOB NOT NULL, wrapped_dek TEXT NOT NULL, dek_version INTEGER NOT NULL DEFAULT 1, alg TEXT NOT NULL, endpoint TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, PRIMARY KEY (user_id, client_id))",
  );
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL, ts INTEGER NOT NULL, detail TEXT)",
  );
});

// ── 1. Service-auth minter — byte-equal to pinning-webui's verifyServiceAuth ──
describe("mintServiceAuthHeader — cross-language shared vector (locks Go/Rust/TS)", () => {
  // The SAME vector as pinning-webui/tests/serviceAuth.test.ts + the Go/Rust tests.
  // mintServiceAuthHeader computes exp = nowSec + 120, so pass nowSec = VEC_EXP - 120.
  const VEC_SECRET = "fula-pin-svc-shared-test-secret-rotate-me";
  const VEC_USER = "2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff";
  const VEC_EXP = 4102444800;
  const VEC_HEADER =
    "v1.MmQyZGZmZmRhZDYyZmY5MjdhYmJhMTI5NWM3M2E0ZWFiNzY2NjgxMzI4MGVhOGIzNTZkYTg0NWU0NDBjNDFmZg.4102444800.7kiFsUP9DMnoeP00uwbUwy4tJmTC6rpy9Dce_e-jw3U";

  it("produces the exact shared header (Worker minter == pinning-webui verifier wire format)", async () => {
    expect(await mintServiceAuthHeader(VEC_USER, VEC_SECRET, VEC_EXP - 120)).toBe(VEC_HEADER);
  });
});

// ── 2. loadCollabSession — fetch the bundle BY PUBKEY (C2) ────────────────────
describe("loadCollabSession — by-pubkey C2 fetch (service-auth'd)", () => {
  it("404 from C2 → null (no group connected); sends the by-pubkey URL + service-auth header", async () => {
    const uid = await emailToUserId("s3-fetch@example.com");
    const clientId = "https://claude.ai";
    // Seal a keypair for (uid, clientId) so custody exists.
    await loadOrGenerateMcpIdentity(plainEnv(), uid, clientId);

    let seenUrl = "";
    let seenAuth = "";
    const stubFetch = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = h["X-Fula-Service-Auth"] ?? "";
      return new Response("no bundle", { status: 404 });
    }) as unknown as typeof fetch;

    const session = await loadCollabSession(envWithSvc(), uid, clientId, stubFetch);
    expect(session).toBeNull();
    expect(seenUrl).toContain("/api/mcp/connections/by-pubkey/");
    expect(seenUrl.endsWith("/bundle")).toBe(true);
    // base64url pubkey in the path — no '/' or '+' after the fixed prefix.
    const pubSeg = seenUrl.split("/by-pubkey/")[1]?.split("/bundle")[0] ?? "";
    expect(pubSeg.length).toBeGreaterThan(0);
    expect(/[+/]/.test(pubSeg)).toBe(false);
    // A well-formed service-auth header was minted.
    expect(seenAuth).toMatch(/^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/);
  });

  it("no keypair custody → null BEFORE any fetch (fail-closed, nothing to fetch)", async () => {
    const uid = await emailToUserId("s3-never-sealed@example.com");
    let called = false;
    const stubFetch = (async () => { called = true; return new Response("", { status: 404 }); }) as unknown as typeof fetch;
    const session = await loadCollabSession(envWithSvc(), uid, "https://claude.ai", stubFetch);
    expect(session).toBeNull();
    expect(called).toBe(false);
  });

  it("fails closed when FULA_PIN_SERVICE_SECRET / FULA_WEBUI_BASE are unset", async () => {
    const uid = await emailToUserId("s3-unconfigured@example.com");
    await loadOrGenerateMcpIdentity(plainEnv(), uid, "https://claude.ai");
    const stubFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    // plainEnv() has neither FULA_WEBUI_BASE nor FULA_PIN_SERVICE_SECRET → throws.
    await expect(loadCollabSession(plainEnv(), uid, "https://claude.ai", stubFetch)).rejects.toThrow();
  });
});

// ── 3. fula_identity tool (C3) ────────────────────────────────────────────────
describe("fula_identity tool — returns C3 { fula_id, mcp_pub_b64, message }", () => {
  async function callTool(name: string, args: unknown, props: Record<string, unknown>, e: CapabilityEnv): Promise<any> {
    const server = buildServer(e);
    const handler = createMcpHandler(server, { route: MCP_ROUTE, authContext: { props } });
    const req = new Request(`http://localhost${MCP_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const res = await handler(req, {} as never, { props } as never);
    const text = await res.text();
    const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:") || l.startsWith("{"));
    const jsonStr = line?.startsWith("data:") ? line.slice(5).trim() : line ?? text;
    return JSON.parse(jsonStr);
  }

  it("returns a FULA- id + pubkey + a user-relayable message for an authed AI", async () => {
    const email = "s3-identity@example.com";
    const uid = await emailToUserId(email);
    const rpc = await callTool("fula_identity", {}, { email, userId: uid, clientId: "https://claude.ai" }, plainEnv());
    expect(rpc.error).toBeUndefined();
    const payload = rpc.result.structuredContent ?? JSON.parse(rpc.result.content[0].text);
    expect(payload.fula_id).toMatch(/^FULA-/);
    expect(typeof payload.mcp_pub_b64).toBe("string");
    expect(payload.mcp_pub_b64.length).toBeGreaterThan(0);
    expect(payload.message).toContain("FxFiles");
  });

  it("two AI clients (same user) get DISTINCT fula_ids (per-AI identity)", async () => {
    const email = "s3-identity-two@example.com";
    const uid = await emailToUserId(email);
    const a = await callTool("fula_identity", {}, { email, userId: uid, clientId: "https://claude.ai" }, plainEnv());
    const b = await callTool("fula_identity", {}, { email, userId: uid, clientId: "https://chatgpt.com" }, plainEnv());
    const pa = a.result.structuredContent ?? JSON.parse(a.result.content[0].text);
    const pb = b.result.structuredContent ?? JSON.parse(b.result.content[0].text);
    expect(pa.fula_id).not.toBe(pb.fula_id);
  });

  it("fails closed when client_id is absent from the grant", async () => {
    const email = "s3-identity-noclient@example.com";
    const uid = await emailToUserId(email);
    const rpc = await callTool("fula_identity", {}, { email, userId: uid }, plainEnv()); // no clientId
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toContain("client identity");
  });
});
