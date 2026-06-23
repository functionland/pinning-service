/**
 * The Fula hosted MCP server (H1 skeleton).
 *
 * Transport: stateless Streamable-HTTP via `agents`' `createMcpHandler`. We pick
 * the STATELESS handler (not `McpAgent`/Durable Object) because H1 is a stub with
 * one stateless tool — there is no per-session server state to persist across
 * requests, so a Durable Object would be dead weight. (When real, stateful tools
 * arrive in a later phase we can migrate to `McpAgent` without changing the OAuth
 * layer; the identity plumbing below — `ctx.props` → `getMcpAuthContext()` — is
 * identical for both.)
 *
 * Identity plumbing (verified against the installed library internals):
 *   1. `@cloudflare/workers-oauth-provider`'s `handleApiRequest` validates the
 *      bearer access token, ENFORCES audience/recipient binding (rejects 401 if
 *      the token's recorded audience origin != this Worker's origin), decrypts
 *      the grant's `props`, and sets `ctx.props = <decrypted props>`.
 *   2. `createMcpHandler` reads `ctx.props` and runs the JSON-RPC request inside
 *      `runWithAuthContext({ props })`.
 *   3. A tool calls `getMcpAuthContext()` to read `{ props }` and derives the
 *      Fula `user_id` from `props.email`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import { z } from "zod";
import { emailToUserId } from "./userId.js";

/** Path the MCP Streamable-HTTP endpoint is served at. Must equal the
 *  OAuthProvider `apiRoute` in index.ts and the `resource` in the RFC 9728
 *  metadata so spec-compliant clients bind their token to it. */
export const MCP_ROUTE = "/mcp";

/** Server name/version advertised in the MCP `initialize` response. */
const SERVER_INFO = { name: "fula-mcp", version: "0.1.0" } as const;

/**
 * Shape of the authenticated identity we stash in the OAuth grant's encrypted
 * `props` (set by the Google federation callback via `completeAuthorization`).
 * Email lives ONLY in the E2E-encrypted props (never in the unencrypted grant
 * metadata); the stable pseudonymous `user_id` is derived from it on demand.
 */
export interface FulaAuthProps {
  /** The verified Google account email (lowercased at federation time). */
  email: string;
  /** Optional display name (encrypted props only). */
  name?: string;
  /** SHA-256(lowercased email) hex — also passed as the grant's `userId`. */
  userId: string;
  [key: string]: unknown;
}

/**
 * Build a FRESH `McpServer` for a single request. The stateless handler REQUIRES
 * a new instance per request — reusing a connected server throws
 * ("Server is already connected to a transport. Create a new McpServer instance
 * per request for stateless handlers.").
 */
export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  // ── fula_ping — the H1 stub tool ───────────────────────────────────────────
  // Proves the whole chain: OAuth (audience-bound token) → decrypted identity
  // props → MCP tool dispatch → derived Fula user_id. Takes no input; returns
  // the caller's user_id and a server timestamp.
  server.registerTool(
    "fula_ping",
    {
      title: "Fula ping",
      description:
        "Connectivity + identity check. Returns the authenticated caller's " +
        "Fula user_id (SHA-256 of their account email) and a server timestamp. " +
        "Proves OAuth → identity → tool dispatch end to end.",
      inputSchema: {},
    },
    async () => {
      const auth = getMcpAuthContext();
      const props = auth?.props as FulaAuthProps | undefined;

      // The tool MUST NOT run unauthenticated. In production every /mcp request
      // is gated by the OAuth provider (no valid token ⇒ 401 before we ever get
      // here), so a missing identity indicates a misconfiguration — fail closed.
      if (!props?.email) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Not authenticated: no Fula identity in this MCP session.",
            },
          ],
        };
      }

      // Derive the user_id the SAME way the webui does. Prefer the precomputed
      // `props.userId` (set at federation), but recompute from email as the
      // source of truth so this tool is correct even if props omitted it.
      const connectedAs =
        typeof props.userId === "string" && props.userId.length === 64
          ? props.userId
          : await emailToUserId(props.email);

      const payload = {
        connected_as: connectedAs,
        ts: new Date().toISOString(),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );

  return server;
}

/**
 * The OAuth provider's `apiHandler` target: every authenticated request to
 * `apiRoute` ("/mcp") lands here with `ctx.props` already populated. We build a
 * fresh server and delegate to `createMcpHandler`, which honours the Streamable
 * HTTP transport and exposes the identity via `getMcpAuthContext()`.
 */
export const mcpApiHandler = {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response> {
    return createMcpHandler(buildServer(), { route: MCP_ROUTE })(
      request,
      env as never,
      ctx as never,
    );
  },
};

// Re-export the input schema type marker so the stub's contract is greppable.
export const FULA_PING_INPUT = z.object({}).strict();
