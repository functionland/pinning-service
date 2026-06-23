/**
 * The stub tool (`fula_ping`) + identity derivation.
 *
 * Proves OAuth → identity → tool dispatch WITHOUT minting a real token: we inject
 * a mock authenticated session via `createMcpHandler`'s `authContext` option
 * (which short-circuits `ctx.props`), drive a real MCP `tools/call`, and assert
 * the tool returns the Fula `user_id` derived from the session email.
 *
 * Also pins `emailToUserId` to a known vector to guarantee byte-for-byte parity
 * with pinning-webui's `emailToUserId` (SHA-256 of the lowercased email, hex) —
 * if these diverge, the same human becomes two different user_ids.
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { buildServer, MCP_ROUTE } from "../src/mcp.js";
import { emailToUserId } from "../src/userId.js";

// Known vector — independently computed (PowerShell SHA256) and matches the
// pinning-webui test fixture `emailToUserId('mcp-test@example.com')`.
const TEST_EMAIL = "mcp-test@example.com";
const EXPECTED_USER_ID =
  "5f5b298817ce8e64b4c5a80f7e5291b0272d975747a309eb707062bdd76e2365";

describe("emailToUserId — parity with pinning-webui", () => {
  it("matches the known SHA-256(lowercased email) hex vector", async () => {
    expect(await emailToUserId(TEST_EMAIL)).toBe(EXPECTED_USER_ID);
  });

  it("is case-insensitive on the email (lowercased before hashing)", async () => {
    expect(await emailToUserId("MCP-Test@Example.COM")).toBe(EXPECTED_USER_ID);
  });
});

/** Drive a JSON-RPC request through createMcpHandler with an injected session. */
async function callTool(
  method: string,
  params: unknown,
  props: Record<string, unknown>,
): Promise<any> {
  const server: McpServer = buildServer();
  const handler = createMcpHandler(server, {
    route: MCP_ROUTE,
    authContext: { props },
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
  // Streamable-HTTP may answer as SSE (`data: {json}`) or plain JSON.
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:") || l.startsWith("{"));
  const jsonStr = line?.startsWith("data:") ? line.slice(5).trim() : line ?? text;
  return JSON.parse(jsonStr);
}

describe("fula_ping stub tool", () => {
  const session = { email: TEST_EMAIL, userId: EXPECTED_USER_ID };

  it("returns connected_as = the caller's Fula user_id, derived from the session", async () => {
    const rpc = await callTool("tools/call", { name: "fula_ping", arguments: {} }, session);
    expect(rpc.error).toBeUndefined();

    const result = rpc.result;
    // Prefer structuredContent; fall back to parsing the text block.
    const payload =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(payload.connected_as).toBe(EXPECTED_USER_ID);
    expect(typeof payload.ts).toBe("string");
    // ts is a valid ISO timestamp.
    expect(Number.isNaN(Date.parse(payload.ts))).toBe(false);
  });

  it("derives user_id from email alone when props.userId is absent", async () => {
    const rpc = await callTool(
      "tools/call",
      { name: "fula_ping", arguments: {} },
      { email: TEST_EMAIL }, // no precomputed userId
    );
    const result = rpc.result;
    const payload =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.connected_as).toBe(EXPECTED_USER_ID);
  });

  it("lists fula_ping in tools/list", async () => {
    const rpc = await callTool("tools/list", {}, session);
    const names = (rpc.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("fula_ping");
  });
});
