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
 *   3. A tool calls `getMcpAuthContext()` to read `{ props }` and resolves the
 *      Fula `user_id` — preferring the `props.userId` precomputed at federation,
 *      falling back to deriving it from `props.email` (both yield the same value).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import { z } from "zod";
import { emailToUserId } from "./userId.js";
import type { CapabilityEnv } from "./capability.js";
import {
  storeFile,
  readFile,
  listFiles,
  search,
  tagFile,
  listTags,
  type ToolResult,
} from "./fula/tools.js";
import { CATEGORIES } from "./fula/classify.js";

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
 * Resolve the Fula user_id from a set of decrypted OAuth grant `props` — the
 * LOAD-SIDE keying for the H2/H3 capability seam. This MUST agree, for the same
 * human, with the STORE-SIDE keying in `capability.ts handleCapability` (which
 * uses `emailToUserId(props.email)`), or an AI would OAuth-connect yet every tool
 * call would fail "no capability found". Both sides read the SAME grant `props`
 * (set once at federation, `google.ts` → `{ email, userId: emailToUserId(email) }`),
 * so preferring the precomputed `props.userId` here yields the same value the
 * store side derived. Recomputes from email when `props.userId` is absent/ill-
 * shaped (the email is the source of truth). Returns null when there is no
 * identity at all. Factored out (vs inlined in `resolveUserId`) so the seam test
 * can drive the REAL load-side derivation rather than a copy of it.
 */
export async function resolveUserIdFromProps(
  props: FulaAuthProps | undefined,
): Promise<string | null> {
  if (!props?.email) return null;
  if (typeof props.userId === "string" && props.userId.length === 64) {
    return props.userId;
  }
  return emailToUserId(props.email);
}

/**
 * Resolve the authenticated Fula user_id from the current MCP auth context, or
 * null if there is no identity (which in production cannot happen — the OAuth
 * provider 401s before dispatch — so a null indicates misconfiguration).
 */
async function resolveUserId(): Promise<string | null> {
  const auth = getMcpAuthContext();
  return resolveUserIdFromProps(auth?.props as FulaAuthProps | undefined);
}

/** Wrap a tool body with identity resolution + a uniform "not authenticated". */
async function withUser(
  run: (userId: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const userId = await resolveUserId();
  if (!userId) {
    return {
      isError: true,
      content: [
        { type: "text", text: "Not authenticated: no Fula identity in this MCP session." },
      ],
    };
  }
  return run(userId);
}

/**
 * Build a FRESH `McpServer` for a single request. The stateless handler REQUIRES
 * a new instance per request — reusing a connected server throws
 * ("Server is already connected to a transport. Create a new McpServer instance
 * per request for stateless handlers.").
 *
 * `env` carries the custody + OpenBao bindings the real tools need to load a
 * session capability. It is OPTIONAL so the H1 identity tests (which only drive
 * `fula_ping`) can call `buildServer()` with no env; the workspace tools are only
 * reachable when a real env is supplied (production passes it per request).
 */
export function buildServer(env?: CapabilityEnv): McpServer {
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

  // ── The workspace tools (H3) ───────────────────────────────────────────────
  // Only registered when a real env is supplied (they need custody + OpenBao).
  // The `env` is closed over per request — there is no ambient env inside a tool
  // callback in Workers, so capturing it here is how the tools reach custody.
  if (env) {
    const categoryEnum = z.enum(CATEGORIES);

    server.registerTool(
      "fula_store_file",
      {
        title: "Store a file in the AI workspace",
        description:
          "Encrypt and upload a file into your private AI workspace (a dedicated, " +
          "end-to-end-encrypted area, FxFiles-compatible format). Returns the key " +
          "you use to read it back. `encoding` MUST be 'base64' for binary files " +
          "and 'utf8' for text — choosing wrong corrupts the bytes. Files are " +
          "AI-workspace-private: the AI can read them back; the FxFiles app cannot " +
          "yet read AI-written files.",
        inputSchema: {
          content: z.string().describe("File contents, encoded per `encoding`."),
          encoding: z
            .enum(["utf8", "base64"])
            .describe("'utf8' for text, 'base64' for binary. Required."),
          name: z.string().optional().describe("Filename (drives category + key)."),
          mime: z.string().optional().describe("MIME type, e.g. image/png."),
          tags: z.array(z.string()).optional().describe("Optional tags (advisory)."),
          category: categoryEnum.optional().describe("Override the auto category."),
        },
      },
      async (a) =>
        withUser((userId) =>
          storeFile(env, userId, {
            content: a.content,
            encoding: a.encoding,
            name: a.name,
            mime: a.mime,
            tags: a.tags,
            category: a.category,
          }),
        ),
    );

    server.registerTool(
      "fula_read_file",
      {
        title: "Read a file from the AI workspace",
        description:
          "Download and decrypt one of YOUR AI-workspace files by its key " +
          "(ai/<category>/<id>-<name>). Returns the content. Defaults to 'base64' " +
          "(lossless for any bytes); pass encoding 'utf8' to get text directly " +
          "(errors if the file is not valid UTF-8).",
        inputSchema: {
          key: z.string().describe("The workspace key returned by fula_store_file."),
          encoding: z
            .enum(["utf8", "base64"])
            .optional()
            .describe("Output encoding; default 'base64'."),
        },
      },
      async (a) =>
        withUser((userId) => readFile(env, userId, { key: a.key, encoding: a.encoding })),
    );

    server.registerTool(
      "fula_list_files",
      {
        title: "List AI-workspace files",
        description:
          "List the files in your AI workspace (confined to the ai/ scope), " +
          "optionally filtered by category or a key substring.",
        inputSchema: {
          category: categoryEnum.optional().describe("Only this category."),
          prefix: z.string().optional().describe("Keep keys containing this substring."),
        },
      },
      async (a) =>
        withUser((userId) => listFiles(env, userId, { category: a.category, prefix: a.prefix })),
    );

    // ── fula_search (H3b) ───────────────────────────────────────────────────
    server.registerTool(
      "fula_search",
      {
        title: "Search AI-workspace files",
        description:
          "Search YOUR AI workspace by filename: returns files whose name contains " +
          "`query` (case-insensitive substring; an empty query returns every file). " +
          "Optionally pass `tag` to also restrict to files carrying that tag name " +
          "(combined with the name match). Only your own ai/ workspace is searched.",
        inputSchema: {
          query: z.string().describe("Filename substring (case-insensitive; empty matches all)."),
          tag: z
            .string()
            .optional()
            .describe("Optional: also require this tag name (AND-combined with query)."),
        },
      },
      async (a) => withUser((userId) => search(env, userId, { query: a.query, tag: a.tag })),
    );

    // ── fula_tag_file (H3b) ─────────────────────────────────────────────────
    server.registerTool(
      "fula_tag_file",
      {
        title: "Tag an AI-workspace file",
        description:
          "Add one or more tags to one of YOUR AI-workspace files (by its key from " +
          "fula_store_file / fula_list_files). Tags are written in FxFiles' native " +
          "tag format so the FxFiles app can later adopt them. Tag names dedupe " +
          "case-insensitively; re-tagging the same file with the same tag is a no-op.",
        inputSchema: {
          key: z.string().describe("The workspace file key (ai/<category>/<id>-<name>)."),
          tags: z.array(z.string()).describe("One or more tag names to apply. Required."),
        },
      },
      async (a) => withUser((userId) => tagFile(env, userId, { key: a.key, tags: a.tags })),
    );

    // ── fula_list_tags (H3b) ────────────────────────────────────────────────
    server.registerTool(
      "fula_list_tags",
      {
        title: "List AI-workspace tags",
        description:
          "List all tags in your AI workspace (the FxFiles-format tag cloud): each " +
          "tag's name, color, and how many files carry it.",
        inputSchema: {},
      },
      async () => withUser((userId) => listTags(env, userId)),
    );
  }

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
    // The runtime env is a superset of CapabilityEnv (custody DB + OpenBao +
    // OAUTH_PROVIDER). Pass it so the workspace tools can load a session
    // capability; the identity still flows via getMcpAuthContext().
    return createMcpHandler(buildServer(env as CapabilityEnv), { route: MCP_ROUTE })(
      request,
      env as never,
      ctx as never,
    );
  },
};
