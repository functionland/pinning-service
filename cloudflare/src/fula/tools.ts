/**
 * The real MCP tools: store / read / list (+ search/tag stubs) for the AI's
 * encrypted workspace (H3).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * PER-SESSION FLOW (one per authenticated MCP tool call), via `withWorkspaceClient`:
 *   1. loadCapabilityForSession(env, userId)  — decrypt the custodied capability
 *      (H2; OpenBao unwraps the per-record DEK). Throws ⇒ "custody unavailable".
 *   2. Refresh the SHORT-LIVED gateway JWT: POST {refresh_url}{refresh_token} →
 *      {token} (cached briefly per user; coalesced; re-refreshed on a 401).
 *   3. Build a Fula `EncryptedClient` from { endpoint, that JWT } + the
 *      workspace_secret, configured IDENTICALLY to FxFiles' workspace client
 *      (enableMetadataPrivacy: true, obfuscationMode: 'flatNamespace') so objects
 *      are FxFiles-compatible.
 *   4. Run the tool body.
 *   5. finally: free the WASM client handle AND dispose() the capability (which
 *      best-effort zeroizes the decrypted secret bytes). We do NOT rely on the
 *      finalizer for this.
 *
 * Retry-once on a gateway 401 (mirrors the local fula-mcp L1c retry): invalidate
 * the cached JWT, force a refresh, rebuild the client, run once more.
 *
 * FORMAT FIDELITY: "FxFiles-compatible", NOT "deterministic byte-identical" —
 * HPKE/AES use random nonces, so two encryptions of the same plaintext differ by
 * design (advisor: Codex). What matters is that an object written here decrypts
 * under FxFiles' workspace client and vice-versa; that follows from using the
 * SAME pinned WASM build + the SAME workspace EncryptionConfig.
 *
 * SCOPE: every key is segment-contained in the `ai/` scope (defense in depth; the
 * gateway also scopes the JWT to the AI-workspace bucket). Files written here are
 * AI-WORKSPACE-PRIVATE: the AI can read back what it wrote, but the FxFiles owner
 * cannot yet read AI-written files — that needs owner-share minting, which the
 * current JS client does NOT expose (deferred to H3b; see fula_store_file's note).
 */

import { loadCapabilityForSession, recordAudit, type CapabilityEnv } from "../capability.js";
import {
  createEncryptedClient,
  putEncryptedWithType,
  getDecrypted,
  listDecrypted,
  freeClient,
  type EncryptedClient,
  type FileMetadata,
} from "./wasm.js";
import { gatewayTokenCache, GatewayRefreshError } from "./gateway.js";
import {
  WORKSPACE_BUCKET,
  WORKSPACE_KEY_PREFIX,
  buildWorkspaceKey,
  classify,
  freshUuidSimple,
  isInWorkspaceScope,
  type Category,
} from "./classify.js";
import { decodeContent, encodeContent, ContentError, type ContentEncoding } from "./content.js";
import type { Capability } from "../custody.js";

/**
 * A tool result the MCP layer understands. The index signature keeps it
 * structurally compatible with the MCP SDK's `CallToolResult` (which carries an
 * open `[x: string]: unknown`), so these flow straight into `registerTool`.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [x: string]: unknown;
}

/** Build a successful tool result carrying a JSON payload. */
function ok(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
/** Build an error tool result (isError so the client surfaces it). */
function err(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Detect a gateway 401 from a fula-client structured error. The client surfaces
 * errors as `JsError` whose `.message` is JSON `{ code, operation, message, data }`.
 * A 401 lands as ACCESS_DENIED or an HTTP error carrying status 401. We parse
 * defensively and fall back to a substring check.
 */
function isUnauthorized(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  try {
    const parsed = JSON.parse(e.message) as {
      code?: string;
      data?: { status?: number } & Record<string, unknown>;
    };
    if (parsed?.data?.status === 401) return true;
    if (parsed?.code === "ACCESS_DENIED") return true;
  } catch {
    // not JSON — fall through to substring
  }
  return /\b401\b|unauthor/i.test(e.message);
}

/**
 * The higher-order session wrapper. Loads the capability, refreshes the gateway
 * JWT, builds the workspace client, runs `body`, and GUARANTEES cleanup (free the
 * WASM handle + dispose the capability) in `finally`. Retries once on a 401.
 */
export async function withWorkspaceClient<T>(
  env: CapabilityEnv,
  userId: string,
  body: (client: EncryptedClient) => Promise<T>,
): Promise<T> {
  let cap: Capability | null = null;
  try {
    cap = await loadCapabilityForSession(env, userId);
    if (!cap) {
      throw new NoCapabilityError();
    }
    const c = cap.get();
    const secret = base64ToBytes(c.workspace_secret);
    try {
      const cache = gatewayTokenCache();
      let attempt = 0;
      // Up to two attempts: fresh-or-cached JWT, then a forced refresh on a 401.
      for (;;) {
        const token = await cache.getToken(
          userId,
          c.refresh_url,
          c.refresh_token,
          attempt > 0, // force a refresh on the retry
        );
        let client: EncryptedClient | null = null;
        try {
          client = await createEncryptedClient(
            { endpoint: c.endpoint, accessToken: token },
            { secretKey: secret, obfuscationMode: "flatNamespace", enableMetadataPrivacy: true },
          );
          return await body(client);
        } catch (e) {
          if (attempt === 0 && isUnauthorized(e)) {
            cache.invalidate(userId);
            attempt++;
            continue; // rebuild client with a fresh token, retry once
          }
          throw e;
        } finally {
          freeClient(client);
        }
      }
    } finally {
      // Best-effort zeroize the workspace secret bytes we own (the WASM may have
      // copied them internally; this is hygiene for the JS-side copy).
      secret.fill(0);
    }
  } finally {
    cap?.dispose(); // best-effort zeroize the decrypted capability plaintext
  }
}

/** No custodied capability for this user (they haven't delegated from FxFiles). */
export class NoCapabilityError extends Error {
  constructor() {
    super("no_capability");
    this.name = "NoCapabilityError";
  }
}

// ── Tool: fula_store_file (CORE) ─────────────────────────────────────────────
export interface StoreArgs {
  content: string;
  encoding: ContentEncoding;
  name?: string;
  mime?: string;
  tags?: string[];
  category?: Category;
}

/**
 * Classify → encrypt → upload under `fula-ai-workspace`/`ai/<category>/…`, in the
 * FxFiles-compatible format. Returns `{ key, bucket, etag, category }`.
 *
 * NOTE the response flags that the file is AI-workspace-private (FxFiles owner-
 * share minting is not available via the hosted client — H3b).
 */
export async function storeFile(
  env: CapabilityEnv,
  userId: string,
  args: StoreArgs,
): Promise<ToolResult> {
  let data: Uint8Array;
  try {
    data = decodeContent(args.content, args.encoding);
  } catch (e) {
    return err(e instanceof ContentError ? e.message : "invalid content");
  }
  const isText = args.encoding === "utf8";
  const category =
    args.category ?? classify(args.mime, args.name, isText ? args.content : undefined);
  const key = buildWorkspaceKey(category, args.name, freshUuidSimple());
  // Defense in depth (the gateway also scopes the bucket): refuse a key that is
  // not segment-contained in `ai/`. With our own key builder this never trips,
  // but we never trust the path implicitly.
  if (!isInWorkspaceScope(key)) {
    return err("internal: constructed key is out of the ai/ workspace scope");
  }
  const contentType = args.mime && args.mime.length > 0 ? args.mime : defaultContentType(isText);

  try {
    const result = await withWorkspaceClient(env, userId, async (client) => {
      const put = await putEncryptedWithType(client, WORKSPACE_BUCKET, key, data, contentType);
      return put;
    });
    await recordAudit(env.CUSTODY_DB, userId, "mcp_store_file", {
      key,
      category,
      bytes: data.length,
    });
    return ok({
      key,
      bucket: WORKSPACE_BUCKET,
      category,
      etag: typeof result.etag === "string" ? result.etag : undefined,
      tags: args.tags ?? [],
      visibility: "ai-workspace-private",
      note:
        "Stored in your AI workspace (FxFiles-compatible encrypted format). " +
        "Owner-share minting (so the FxFiles app can read AI-written files) is " +
        "not yet available in the hosted MCP — the AI can read this back; FxFiles " +
        "cannot yet.",
    });
  } catch (e) {
    return err(toolErrorMessage(e, "store"));
  } finally {
    data.fill(0); // drop the plaintext we own
  }
}

// ── Tool: fula_read_file (CORE) ──────────────────────────────────────────────
export interface ReadArgs {
  key: string;
  encoding?: ContentEncoding;
}

/** Scoped download + decrypt of one of the AI's OWN workspace files by key. */
export async function readFile(
  env: CapabilityEnv,
  userId: string,
  args: ReadArgs,
): Promise<ToolResult> {
  const key = args.key;
  if (!isInWorkspaceScope(key)) {
    return err(`key '${key}' is not inside the ai/ workspace scope`);
  }
  // Default to base64 (lossless for any bytes); caller may ask for utf8 text.
  const encoding: ContentEncoding = args.encoding ?? "base64";
  try {
    const bytes = await withWorkspaceClient(env, userId, async (client) => {
      return getDecrypted(client, WORKSPACE_BUCKET, key);
    });
    let out: string;
    try {
      out = encodeContent(bytes, encoding);
    } catch {
      bytes.fill(0);
      return err(
        `file at '${key}' is not valid UTF-8 text; re-read with encoding: "base64" to get the raw bytes.`,
      );
    }
    bytes.fill(0);
    await recordAudit(env.CUSTODY_DB, userId, "mcp_read_file", { key });
    return ok({ key, bucket: WORKSPACE_BUCKET, encoding, content: out });
  } catch (e) {
    return err(toolErrorMessage(e, "read"));
  }
}

// ── Tool: fula_list_files ────────────────────────────────────────────────────
export interface ListArgs {
  category?: Category;
  prefix?: string;
}

/** List the AI's workspace forest, confined to the `ai/` scope (+ optional filter). */
export async function listFiles(
  env: CapabilityEnv,
  userId: string,
  args: ListArgs,
): Promise<ToolResult> {
  // The scope prefix the listing narrows to (ai, or ai/<category>).
  const scopePrefix = args.category
    ? `${WORKSPACE_KEY_PREFIX}/${args.category}`
    : WORKSPACE_KEY_PREFIX;
  try {
    const rows = await withWorkspaceClient(env, userId, async (client) => {
      return listDecrypted(client, WORKSPACE_BUCKET, { prefix: `${scopePrefix}/` });
    });
    // Confine EVERY returned entry by the same segment geometry (treat the
    // listing as untrusted — never let a non-ai/ key leak through).
    const files = rows
      .map(toListEntry)
      .filter((f): f is ListEntry => f !== null && isInWorkspaceScope(f.key))
      .filter((f) => (args.prefix ? f.key.includes(args.prefix!) : true));
    return ok({ bucket: WORKSPACE_BUCKET, count: files.length, files });
  } catch (e) {
    return err(toolErrorMessage(e, "list"));
  }
}

interface ListEntry {
  key: string;
  storageKey?: string;
  size?: number;
  contentType?: string;
  modifiedAt?: number;
}
function toListEntry(m: FileMetadata): ListEntry | null {
  const key = m.originalKey;
  if (typeof key !== "string" || key.length === 0) return null;
  return {
    key,
    storageKey: typeof m.storageKey === "string" ? m.storageKey : undefined,
    size: typeof m.size === "number" ? m.size : undefined,
    contentType: typeof m.contentType === "string" ? m.contentType : undefined,
    modifiedAt: typeof m.modifiedAt === "number" ? m.modifiedAt : undefined,
  };
}

// ── Tools: fula_search / fula_tag_file / fula_list_tags (STUBS → H3b) ─────────
// These need extra machinery the hosted client/budget doesn't cover yet:
//   • search    → list + filename filter is feasible, but tag-aware search needs
//                 the TagCloudMetadata document (below).
//   • tag_file  → a read-modify-write of ai/tag-metadata/ai-workspace.json in the
//                 EXACT FxFiles TagCloudMetadata JSON shape; correct concurrency
//                 + byte-shape parity is its own phase.
//   • list_tags → reads that same document.
// They return a clear "not yet implemented in hosted" so an AI gets an honest
// signal rather than a silent empty result. Flagged for H3b.
const NOT_IMPLEMENTED = (tool: string): ToolResult =>
  err(
    `${tool} is not yet implemented in the hosted MCP (H3b). ` +
      `Use fula_store_file / fula_read_file / fula_list_files for now.`,
  );

export function searchStub(): ToolResult {
  return NOT_IMPLEMENTED("fula_search");
}
export function tagFileStub(): ToolResult {
  return NOT_IMPLEMENTED("fula_tag_file");
}
export function listTagsStub(): ToolResult {
  return NOT_IMPLEMENTED("fula_list_tags");
}

// ── helpers ──────────────────────────────────────────────────────────────────
function defaultContentType(isText: boolean): string {
  return isText ? "text/plain; charset=utf-8" : "application/octet-stream";
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Map an internal error to a terse, non-secret tool message. */
function toolErrorMessage(e: unknown, op: string): string {
  if (e instanceof NoCapabilityError) {
    return (
      "No Fula workspace is linked to your account yet. Open the FxFiles app and " +
      "connect this AI assistant to delegate an AI-workspace capability, then retry."
    );
  }
  if (e instanceof GatewayRefreshError) {
    return "Could not obtain a storage access token from the gateway. Please try again shortly.";
  }
  // fula-client structured error → surface only its human `message`, never data.
  if (e instanceof Error) {
    try {
      const parsed = JSON.parse(e.message) as { message?: string; code?: string };
      if (typeof parsed?.message === "string") {
        return `${op} failed: ${parsed.message}`;
      }
    } catch {
      /* not JSON */
    }
    return `${op} failed: ${e.message}`;
  }
  return `${op} failed`;
}
