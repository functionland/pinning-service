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
import { loadCollabSession, loadOrGenerateMcpIdentity, type CapabilityEnv } from "./capability.js";
import {
  storeFile,
  readFile,
  listFiles,
  search,
  createFolder,
  removeFile,
  type CollabSession,
  type ToolResult,
} from "./fula/collab/tools.js";
import { CATEGORIES } from "./fula/classify.js";
import { decodeContent, ContentError } from "./fula/content.js";

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
  /**
   * The connected AI's OAuth client_id (e.g. Claude vs ChatGPT). Set by
   * google.ts at federation from the verified AuthRequest. The PER-AI ISOLATION
   * key: custody is keyed per (user_id, client_id). Optional in the type only for
   * backward-compat with pre-S2 grants — the live path FAILS CLOSED if it's absent.
   */
  clientId?: string;
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

/**
 * Resolve the connected AI's `client_id` from the grant props — the PER-AI keying
 * for custody. Returns null when absent / empty / non-string / over-length; the
 * caller FAILS CLOSED (a blank client_id must NEVER collapse two AIs onto one key
 * slot). A pre-S2 grant (no clientId) or a non-conforming client therefore cannot
 * open/seal custody until it re-authorizes. Factored out (like
 * `resolveUserIdFromProps`) so the seam test drives the real derivation.
 */
export function resolveClientIdFromProps(props: FulaAuthProps | undefined): string | null {
  const c = props?.clientId;
  return typeof c === "string" && c.length > 0 && c.length <= 2048 ? c : null;
}

/** Resolve the client_id from the current MCP auth context (null if absent). */
function resolveClientId(): string | null {
  const auth = getMcpAuthContext();
  return resolveClientIdFromProps(auth?.props as FulaAuthProps | undefined);
}

/** A tool result for an unrecoverable pre-flight failure (not authed / not connected). */
function toolError(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Resolve the identity, load the per-connection collaboration session, and run
 * `body` against it. Surfaces a friendly message when the AI has no Fula identity
 * or has not been connected to a collaboration group yet (no bundle delivered).
 */
async function withCollabSession(
  env: CapabilityEnv,
  body: (session: CollabSession) => Promise<ToolResult>,
): Promise<ToolResult> {
  const userId = await resolveUserId();
  if (!userId) return toolError("Not authenticated: no Fula identity in this MCP session.");
  // Per-AI isolation: the client_id keys custody. FAIL CLOSED if absent (a pre-S2
  // grant or a non-conforming client) — never fall back to a shared key slot.
  const clientId = resolveClientId();
  if (!clientId) {
    return toolError(
      "Not authenticated: no AI client identity in this MCP session (re-connect this AI from FxFiles).",
    );
  }
  let session: CollabSession | null;
  try {
    // The global fetch must keep its `this` (globalThis) inside Workers.
    session = await loadCollabSession(env, userId, clientId, fetch.bind(globalThis));
  } catch (e) {
    // Log the specific failure server-side for ops/debugging (the kind + message
    // describe only the failure KIND, never secret material); the user-facing message
    // stays stable and non-leaky.
    const kind =
      e && typeof e === "object" && "kind" in e
        ? String((e as { kind?: unknown }).kind)
        : e instanceof Error
          ? e.name
          : "unknown";
    console.error("[collab] loadCollabSession failed:", kind, "—", e instanceof Error ? e.message : String(e));
    return toolError(
      "Could not open your collaboration connection (the link secret could not be recovered — " +
        "the connection may need to be re-authorized from FxFiles).",
    );
  }
  if (!session) {
    return toolError(
      "No collaboration group is connected to this AI yet. Open FxFiles, connect this AI assistant " +
        "to a collaboration group, then retry.",
    );
  }
  try {
    return await body(session);
  } finally {
    // Best-effort wipe the recovered link secret from isolate memory once the tool
    // call completes — it derives every manifest + collab-file key (GLM-5.2 review).
    // JS gives no hard zeroization guarantee, but we own this buffer and the session
    // is per-request + discarded; the returned ToolResult never references it.
    try {
      session.linkSecret.fill(0);
    } catch {
      /* noop */
    }
  }
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

  // ── The collaboration tools ────────────────────────────────────────────────
  // Only registered when a real env is supplied (they need custody + OpenBao to
  // load the per-connection bundle). Every tool operates over the ONE collaboration
  // group the AI connection was bound to (no `ai/` workspace scope). The `env` is
  // closed over per request — there is no ambient env in a tool callback in Workers.
  if (env) {
    // ── fula_identity — the AI's Fula identity (the pairing tool) ─────────────
    // The user calls this FIRST: it returns THIS AI connection's stable FULA-... id
    // (its X25519 public key), which the user pastes into FxFiles ("Share with AI
    // Agent") to grant this AI access to a collaboration group. The per-(user,
    // client_id) keypair is generated + sealed on first call. FAILS CLOSED without
    // a resolvable user_id + client_id (same as the collab tools).
    server.registerTool(
      "fula_identity",
      {
        title: "Show this AI's Fula identity",
        description:
          "Return THIS AI connection's Fula identity — a stable FULA-... id (its X25519 " +
          "public key). Share that id with the FxFiles owner: in FxFiles, 'Share with AI " +
          "Agent' → paste the id to grant this AI access to a collaboration group. Takes no input.",
        inputSchema: {},
      },
      async () => {
        const userId = await resolveUserId();
        if (!userId) return toolError("Not authenticated: no Fula identity in this MCP session.");
        const clientId = resolveClientId();
        if (!clientId) {
          return toolError(
            "Not authenticated: no AI client identity in this MCP session (re-connect this AI from FxFiles).",
          );
        }
        let identity: { mcpPubB64: string; mcpFulaId: string };
        try {
          identity = await loadOrGenerateMcpIdentity(env, userId, clientId);
        } catch {
          return toolError("Could not load your Fula AI identity (custody unavailable — please retry).");
        }
        const payload = {
          fula_id: identity.mcpFulaId,
          mcp_pub_b64: identity.mcpPubB64,
          message:
            "Share this Fula id (the FULA-... value) with the FxFiles owner. In FxFiles, open " +
            "'Share with AI Agent' and paste it to grant this AI access to a collaboration group.",
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
      },
    );

    const categoryEnum = z.enum(CATEGORIES);

    server.registerTool(
      "fula_store_file",
      {
        title: "Store a file in the collaboration group",
        description:
          "Encrypt and upload a file into the connected collaboration group (shared, " +
          "end-to-end-encrypted with the group link). Returns the file_id you use to " +
          "read or remove it. `encoding` MUST be 'base64' for binary files and 'utf8' " +
          "for text — choosing wrong corrupts the bytes. Use `subfolder` (e.g. '/notes') " +
          "to place it in a folder.",
        inputSchema: {
          content: z.string().describe("File contents, encoded per `encoding`."),
          encoding: z.enum(["utf8", "base64"]).describe("'utf8' for text, 'base64' for binary. Required."),
          name: z.string().describe("Filename (drives the category + logical path)."),
          mime: z.string().optional().describe("MIME type, e.g. image/png."),
          subfolder: z.string().optional().describe("Containing folder, e.g. '/notes' (omit for the group root)."),
          category: categoryEnum.optional().describe("Override the auto category."),
        },
      },
      async (a) =>
        withCollabSession(env, (session) => {
          let data: Uint8Array;
          try {
            data = decodeContent(a.content, a.encoding);
          } catch (e) {
            return Promise.resolve(toolError(e instanceof ContentError ? e.message : "invalid content"));
          }
          const isText = a.encoding === "utf8";
          return storeFile(session, {
            data,
            fileName: a.name,
            mime: a.mime,
            text: isText ? a.content : undefined,
            subfolder: a.subfolder,
            category: a.category,
          });
        }),
    );

    server.registerTool(
      "fula_read_file",
      {
        title: "Read a file from the collaboration group",
        description:
          "Download and decrypt a group file by its `file_id` (from fula_store_file / " +
          "fula_list_files) or by its logical `path`. Works for BOTH files added directly to " +
          "the group (`enc_type:\"collab\"`) AND files the FxFiles owner shared in from their " +
          "own storage (`enc_type:\"fula\"`) — both are readable here; do not skip a file based " +
          "on its enc_type. Images come back as an inline image; other files come back as " +
          "base64. Very large files may exceed the hosted inline limit — if so, the tool says " +
          "so and they can be read on a local (native) FxFiles MCP.",
        inputSchema: {
          file_id: z.string().optional().describe("The file id returned by fula_store_file / fula_list_files."),
          path: z.string().optional().describe("Alternatively, the file's logical path, e.g. '/notes/memo.txt'."),
        },
      },
      async (a) => withCollabSession(env, (session) => readFile(session, { fileId: a.file_id, path: a.path })),
    );

    server.registerTool(
      "fula_list_files",
      {
        title: "List collaboration-group files",
        description:
          "List the files in the connected collaboration group, optionally narrowed by " +
          "a `folder` (e.g. '/notes') or `category`. Set `include_directories` to also " +
          "return folder markers (for building a tree).",
        inputSchema: {
          folder: z.string().optional().describe("Only entries under this folder."),
          category: categoryEnum.optional().describe("Only this category."),
          include_directories: z.boolean().optional().describe("Include folder markers (default false)."),
        },
      },
      async (a) =>
        withCollabSession(env, (session) =>
          listFiles(session, { folder: a.folder, category: a.category, includeDirectories: a.include_directories }),
        ),
    );

    server.registerTool(
      "fula_search",
      {
        title: "Search collaboration-group files",
        description:
          "Search the connected group by filename or path: returns files whose name or " +
          "logical path contains `query` (case-insensitive substring). An empty query " +
          "returns nothing.",
        inputSchema: {
          query: z.string().describe("Filename / path substring (case-insensitive; empty returns nothing)."),
        },
      },
      async (a) => withCollabSession(env, (session) => search(session, a.query)),
    );

    server.registerTool(
      "fula_create_folder",
      {
        title: "Create a folder in the collaboration group",
        description:
          "Create a folder (directory marker) at `path` (e.g. '/notes/2026') in the " +
          "connected group, so subsequent files can be organized under it.",
        inputSchema: {
          path: z.string().describe("The folder path to create, e.g. '/notes/2026'."),
        },
      },
      async (a) => withCollabSession(env, (session) => createFolder(session, a.path)),
    );

    server.registerTool(
      "fula_remove_file",
      {
        title: "Remove a file from the collaboration group",
        description:
          "Remove a file from the group manifest by its `file_id` (a tombstone — the " +
          "encrypted object is NOT globally deleted, so other members are unaffected). " +
          "Idempotent: removing an absent id is a no-op.",
        inputSchema: {
          file_id: z.string().describe("The file id to remove (from fula_store_file / fula_list_files)."),
        },
      },
      async (a) => withCollabSession(env, (session) => removeFile(session, a.file_id)),
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
