/**
 * MCP tool DISPATCH tests for the H3 workspace tools (store/read/list + stubs).
 * Drives real JSON-RPC `tools/list` + `tools/call` through createMcpHandler with
 * an injected authenticated session (as tool.test.ts does), and the real test env
 * (miniflare D1 + the test OpenBao config). No real gateway — the round-trip
 * against s3.cloud.fx.land is deferred to H4; here we assert wiring + the
 * fail-closed paths that DON'T need the gateway.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { buildServer, MCP_ROUTE } from "../src/mcp.js";
import type { CapabilityEnv } from "../src/capability.js";

beforeAll(async () => {
  // Apply the custody schema to the (miniflare) local D1 so the no-capability
  // path can query mcp_capabilities (and the audit writes have a table). Mirrors
  // custody.test.ts's setup; miniflare D1 is isolated per test file.
  const d1 = env.CUSTODY_DB as unknown as { exec(q: string): Promise<unknown> };
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_capabilities (user_id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, capability_ciphertext BLOB NOT NULL, wrapped_dek TEXT NOT NULL, dek_version INTEGER NOT NULL DEFAULT 1, alg TEXT NOT NULL, endpoint TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)",
  );
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL, ts INTEGER NOT NULL, detail TEXT)",
  );
});

const TEST_EMAIL = "mcp-test@example.com";
const EXPECTED_USER_ID =
  "5f5b298817ce8e64b4c5a80f7e5291b0272d975747a309eb707062bdd76e2365";

/** Drive one JSON-RPC request with an injected session + the real test env. */
async function callTool(
  method: string,
  params: unknown,
  props: Record<string, unknown> | null,
): Promise<any> {
  const server: McpServer = buildServer(env as unknown as CapabilityEnv);
  const handler = createMcpHandler(server, {
    route: MCP_ROUTE,
    ...(props ? { authContext: { props } } : {}),
  });
  const req = new Request(`http://localhost${MCP_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await handler(req, {} as never, { props } as never);
  const text = await res.text();
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:") || l.startsWith("{"));
  const jsonStr = line?.startsWith("data:") ? line.slice(5).trim() : (line ?? text);
  return JSON.parse(jsonStr);
}

const session = { email: TEST_EMAIL, userId: EXPECTED_USER_ID };

function payloadOf(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

describe("H3 tools — registration", () => {
  it("lists the workspace tools alongside fula_ping when env is present", async () => {
    const rpc = await callTool("tools/list", {}, session);
    const names = (rpc.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("fula_ping");
    expect(names).toContain("fula_store_file");
    expect(names).toContain("fula_read_file");
    expect(names).toContain("fula_list_files");
    expect(names).toContain("fula_search");
    expect(names).toContain("fula_tag_file");
    expect(names).toContain("fula_list_tags");
  });

  it("declares store inputSchema with content + the required encoding discriminator", async () => {
    const rpc = await callTool("tools/list", {}, session);
    const store = (rpc.result.tools as Array<any>).find((t) => t.name === "fula_store_file");
    expect(store).toBeTruthy();
    const props = store.inputSchema.properties;
    expect(props).toHaveProperty("content");
    expect(props).toHaveProperty("encoding");
    // encoding is a required enum of utf8|base64.
    expect(store.inputSchema.required).toContain("content");
    expect(store.inputSchema.required).toContain("encoding");
  });
});

describe("H3 tools — auth gating", () => {
  it("fula_store_file without a session identity is not-authenticated", async () => {
    // No authContext → no props.email → withUser short-circuits.
    const rpc = await callTool(
      "tools/call",
      { name: "fula_store_file", arguments: { content: "hi", encoding: "utf8" } },
      null,
    );
    const result = rpc.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not authenticated/i);
  });
});

describe("H3 tools — fail-closed without a custodied capability", () => {
  // The test D1 has no mcp_capabilities row for this user, so
  // loadCapabilityForSession returns null and the tools must return the friendly
  // "connect FxFiles first" message — NOT crash, and NOT touch the gateway.
  it("fula_store_file → friendly 'no workspace linked' message", async () => {
    const rpc = await callTool(
      "tools/call",
      {
        name: "fula_store_file",
        arguments: { content: "hello world", encoding: "utf8", name: "n.txt" },
      },
      session,
    );
    const result = rpc.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/FxFiles app and connect|no Fula workspace/i);
  });

  it("fula_read_file → same friendly message (for an in-scope key)", async () => {
    const rpc = await callTool(
      "tools/call",
      { name: "fula_read_file", arguments: { key: "ai/note/abc-n.txt" } },
      session,
    );
    const result = rpc.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/FxFiles|no Fula workspace/i);
  });

  it("fula_list_files → same friendly message", async () => {
    const rpc = await callTool(
      "tools/call",
      { name: "fula_list_files", arguments: {} },
      session,
    );
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toMatch(/FxFiles|no Fula workspace/i);
  });
});

describe("H3 tools — input validation BEFORE any custody/gateway work", () => {
  it("fula_read_file rejects an out-of-scope key without touching custody", async () => {
    const rpc = await callTool(
      "tools/call",
      { name: "fula_read_file", arguments: { key: "photos/2026/secret.jpg" } },
      session,
    );
    const result = rpc.result;
    expect(result.isError).toBe(true);
    // The scope rejection fires before the no-capability path → distinct message.
    expect(result.content[0].text).toMatch(/not inside the ai\/ workspace scope/i);
  });

  it("fula_store_file rejects invalid base64 content up front", async () => {
    const rpc = await callTool(
      "tools/call",
      {
        name: "fula_store_file",
        arguments: { content: "not valid base64!!", encoding: "base64" },
      },
      session,
    );
    const result = rpc.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/base64/i);
  });
});

describe("H3 tools — honest stubs", () => {
  it("fula_search returns a clear not-implemented signal", async () => {
    const rpc = await callTool(
      "tools/call",
      { name: "fula_search", arguments: { query: "x" } },
      session,
    );
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toMatch(/not yet implemented/i);
  });
  it("fula_list_tags returns a clear not-implemented signal", async () => {
    const rpc = await callTool(
      "tools/call",
      { name: "fula_list_tags", arguments: {} },
      session,
    );
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toMatch(/not yet implemented/i);
  });
});
