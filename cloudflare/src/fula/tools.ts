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
  putFlat,
  getFlat,
  listFilesFromForest,
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

/** AI-workspace buckets already ensured to exist this isolate (keyed by userId). */
const ensuredWorkspaceBuckets = new Set<string>();

/**
 * Idempotently create the user's dedicated AI-workspace bucket. `fula-client` does
 * NOT auto-create on write (it returns NoSuchBucket — see its
 * `cold_start_returns_bucket_not_found_when_bucket_absent` test), and a hosted
 * connection has nothing else that provisions it, so the AI's first
 * `fula_store_file` would fail with `NoSuchBucket: fula-ai-workspace`. The MCP
 * token's `write` perm permits `CreateBucket` of ONLY this dedicated bucket (any
 * other bucket is `BucketMismatch` at the gateway), so this cannot widen access.
 * Best-effort + cached per-isolate: a non-2xx/409 result is left UNcached so a
 * later op retries, and this never throws (the real op surfaces its own error).
 */
async function ensureWorkspaceBucket(
  endpoint: string,
  bucket: string,
  token: string,
  userId: string,
): Promise<void> {
  if (ensuredWorkspaceBuckets.has(userId)) return;
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(bucket)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
    });
    // 2xx = created; 409 = already exists. Either way the bucket is now present.
    if (res.ok || res.status === 409) {
      ensuredWorkspaceBuckets.add(userId);
    }
  } catch {
    // Best-effort — the following operation will surface any real failure.
  }
}

/**
 * The higher-order session wrapper. Loads the capability, refreshes the gateway
 * JWT, builds the workspace client, runs `body`, and GUARANTEES cleanup (free the
 * WASM handle + dispose the capability) in `finally`. Retries once on a 401.
 */
/** Max times to retry a forest write that lost a conditional-PUT race (412). */
const MAX_FOREST_WRITE_RETRIES = 4;

/**
 * A forest write that lost a conditional-PUT race surfaces as
 * `ClientError::ConcurrentModification` ("precondition failed (ETag mismatch)").
 * Match defensively against the structured/string error (NOT a bare "412", which
 * could be an unrelated precondition) so we only retry true forest races.
 */
function isConcurrentModification(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  let m = msg;
  try {
    const parsed = JSON.parse(msg) as { code?: string; message?: string };
    if (parsed?.code === "CONCURRENT_MODIFICATION") return true;
    if (typeof parsed?.message === "string") m = parsed.message;
  } catch {
    /* not JSON — match the raw string */
  }
  return /concurrent modification|precondition failed|etag mismatch/i.test(m);
}

/** Jittered exponential backoff (~50·2^n ms + 0–50ms, capped) to break herds. */
function sleepWithJitter(attempt: number): Promise<void> {
  const base = Math.min(50 * 2 ** attempt, 400);
  const ms = base + Math.floor(Math.random() * 50);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      let forestRetries = 0;
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
          // Provision the dedicated AI-workspace bucket before any op — fula-client
          // does NOT auto-create on write, so the first store would NoSuchBucket.
          await ensureWorkspaceBucket(c.endpoint, WORKSPACE_BUCKET, token, userId);
          return await body(client);
        } catch (e) {
          if (attempt === 0 && isUnauthorized(e)) {
            cache.invalidate(userId);
            attempt++;
            continue; // rebuild client with a fresh token, retry once
          }
          // Forest write race: put_object_flat flushes the forest with a
          // conditional PUT; a concurrent writer makes it 412
          // (ConcurrentModification). The WASM flush is single-attempt, so retry
          // HERE — re-creating the client drops the now-stale forest cache, so the
          // next attempt reloads the winner's forest and re-applies our write.
          // Bounded + jittered. A read-only body never 412s, so this only fires
          // for store / tag writes.
          if (isConcurrentModification(e) && forestRetries < MAX_FOREST_WRITE_RETRIES) {
            forestRetries++;
            await sleepWithJitter(forestRetries);
            continue;
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
 * FxFiles-compatible format. Returns `{ key, bucket, etag, category, tags }`.
 *
 * If `tags` is non-empty, the file is ALSO associated with those tags in the AI's
 * tag document (the SAME read-modify-write `fula_tag_file` performs) so it is
 * findable by `fula_list_tags` / `fula_search(tag:…)` — the tags are not merely
 * echoed. The tag write happens in the SAME session, AFTER a successful upload,
 * and is BEST-EFFORT: a tag-write failure does NOT fail the store (the file is
 * already stored). It is surfaced as a `tag_warning` and `tags: []` instead, so
 * the response never claims a file is tagged when the association did not persist.
 * (The local Rust `fula-mcp` `store_file` takes no tags and never auto-tags, so
 * there is no precedent to mirror; best-effort-with-warning is the chosen
 * semantics — the primary outcome, the stored file, is preserved.)
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

  // The tags to actually apply: trimmed, empty/whitespace dropped (same filter
  // `applyTagging`/`fula_tag_file` use). When this is empty we skip the tag-doc
  // round-trip entirely, so `store` without (usable) tags is byte-for-byte the
  // prior behavior — no tag document is read or written.
  const requestedTags = Array.isArray(args.tags)
    ? args.tags.map((t) => t.trim()).filter((t) => t.length > 0)
    : [];
  const now = nowIso8601();

  try {
    const result = await withWorkspaceClient(env, userId, async (client) => {
      // The file upload is the primary, retry-on-401 operation.
      const put = await putFlat(client, WORKSPACE_BUCKET, key, data, contentType);
      // BEST-EFFORT tagging in the SAME session, AFTER the file is stored. We do
      // NOT let a tag failure throw (that would fail the whole store, or re-trigger
      // the file upload on the 401 retry): the file IS stored, so the worst case is
      // an un-tagged-but-stored file plus a warning.
      let appliedTags: string[] = [];
      let tagWarning: string | undefined;
      if (requestedTags.length > 0) {
        try {
          await applyTaggingToDoc(client, userId, key, requestedTags, now);
          appliedTags = requestedTags;
        } catch (te) {
          tagWarning =
            te instanceof CorruptTagDocumentError
              ? `file stored, but tagging was skipped: ${te.message}`
              : `file stored, but applying tags failed: ${toolErrorMessage(te, "tag_file")}`;
        }
      }
      return { put, appliedTags, tagWarning };
    });
    await recordAudit(env.CUSTODY_DB, userId, "mcp_store_file", {
      key,
      category,
      bytes: data.length,
      tags: result.appliedTags.length,
    });
    return ok({
      key,
      bucket: WORKSPACE_BUCKET,
      category,
      etag: typeof result.put.etag === "string" ? result.put.etag : undefined,
      // The tags actually associated with the file (searchable), NOT a bare echo.
      tags: result.appliedTags,
      ...(requestedTags.length > 0 ? { metadata_key: TAG_METADATA_KEY } : {}),
      ...(result.tagWarning ? { tag_warning: result.tagWarning } : {}),
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
      return getFlat(client, WORKSPACE_BUCKET, key);
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
      // Enumerate via the forest index. (The raw `listDecrypted` prefix-filters the
      // OBFUSCATED storage keys and returns nothing for this flatNamespace bucket —
      // the bug that made AI files invisible.)
      return listFilesFromForest(client, WORKSPACE_BUCKET);
    });
    // Confine EVERY returned entry by the same segment geometry (treat the listing
    // as untrusted — never let a non-ai/ key leak through), then narrow to the
    // requested category scope (this narrowing was previously the listDecrypted prefix).
    const files = rows
      .map(toListEntry)
      .filter((f): f is ListEntry => f !== null && isInWorkspaceScope(f.key))
      .filter((f) => f.key.startsWith(`${scopePrefix}/`))
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

// ── Tools: fula_search / fula_tag_file / fula_list_tags (H3b) ─────────────────
// Ports the local Rust fula-mcp contracts (tags.rs + list.rs::search) to the
// hosted Worker, scope-confined to the `ai/` AI-workspace (the gateway also
// enforces it). The tag document is FxFiles' EXACT `TagCloudMetadata` JSON shape
// (file_tag.dart) so FxFiles can adopt the AI's tags by an additive-by-id merge.
//
//   • fula_tag_file  → read-modify-write of ai/tag-metadata/ai-workspace.json
//                      (last-writer-wins, matching the Rust + the app's syncToCloud).
//   • fula_list_tags → reads that same document, returns its `tags`.
//   • fula_search    → list (Rust list.rs::search) + filename substring filter,
//                      case-insensitive, empty query matches all; PLUS an optional
//                      `tag` filter (additive superset — AND-combined) resolved via
//                      the same tag-metadata doc. With `tag` omitted it is byte-for-
//                      behavior identical to the local Rust `fula_search(query)`.

/**
 * The logical key the AI's tag-metadata document lives at, inside
 * WORKSPACE_BUCKET (`fula-ai-workspace`). Mirrors the Rust `TAG_METADATA_KEY`.
 *
 * It is UNDER the `ai/` prefix on purpose: the scope gate admits a key only if
 * its first path segment is `ai`, so the app's own `.fula/tags/{userId}.json`
 * form would be DENIED here. This is NOT the user's per-user document — the AI
 * writes its OWN workspace doc; FxFiles adoption (a later phase) reads THIS key.
 */
export const TAG_METADATA_KEY = "ai/tag-metadata/ai-workspace.json";

/**
 * The default ARGB color for an AI-created tag = `0xFF1E88E5` ("Blue" in FxFiles'
 * `TagColors.presetColors`). Serializes as the decimal 4280191205 (a Dart `int`),
 * matching the Rust `DEFAULT_TAG_COLOR`. (The app's own getRandomColor is time-
 * seeded; we pick one fixed, reproducible palette color — the user can recolor.)
 */
export const DEFAULT_TAG_COLOR = 0xff1e88e5; // = 4280191205

/** Recorded as the document `userId` when none is known. The app merges by tag/
 *  file id, not this field, so it is informational. Mirrors Rust FALLBACK_USER_ID. */
const FALLBACK_USER_ID = "ai-workspace";

/** Document `version`, mirroring the Dart `TagCloudMetadata.version` default. */
const TAG_METADATA_VERSION = "1.0";

/**
 * A user-created tag — mirrors FxFiles' `FileTag` (file_tag.dart `toJson`).
 *
 * Field declaration order MATCHES the Dart `toJson` EXACTLY — `JSON.stringify`
 * emits keys in insertion order, so this order is byte-load-bearing:
 * `id, name, colorValue, createdAt, updatedAt, fileCount`.
 */
export interface FileTag {
  id: string;
  name: string;
  /** ARGB color as an int (Dart `Color.value`), e.g. DEFAULT_TAG_COLOR. */
  colorValue: number;
  /** ISO-8601 creation timestamp (`DateTime.toIso8601String()` shape). */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /** Number of files carrying this tag. */
  fileCount: number;
}

/**
 * A file→tag association — mirrors FxFiles' `TaggedFile` (file_tag.dart `toJson`).
 *
 * Field order matches Dart EXACTLY: `id, tagId, localPath, remoteKey, iosAssetId,
 * fileName, taggedAt`. The three location fields are `string | null` and are ALWAYS
 * present (never omitted): an AI-tagged cloud file sets only `remoteKey`, with
 * `localPath`/`iosAssetId` EXPLICITLY `null` — byte-faithful to Dart's
 * `jsonEncode` of a map containing `'localPath': null`. (Using `undefined` would
 * make `JSON.stringify` DROP the key and diverge from the app's bytes.)
 */
export interface TaggedFile {
  id: string;
  tagId: string;
  localPath: string | null;
  remoteKey: string | null;
  iosAssetId: string | null;
  fileName: string;
  taggedAt: string;
}

/**
 * The cloud tag document — mirrors FxFiles' `TagCloudMetadata` (file_tag.dart).
 * Top-level key order matches Dart EXACTLY: `userId, tags, taggedFiles, updatedAt,
 * version`. An empty doc still emits every key (`tags: []`, `taggedFiles: []`).
 */
export interface TagCloudMetadata {
  userId: string;
  tags: FileTag[];
  taggedFiles: TaggedFile[];
  updatedAt: string;
  version: string;
}

/** The outcome of a tag_file call: the doc as written + what changed. */
export interface TagOutcome {
  metadata: TagCloudMetadata;
  /** Names of tags newly CREATED by this call (not previously present). */
  createdTags: string[];
  /** Number of (tag, file) associations newly ADDED by this call. */
  addedAssociations: number;
}

/** A fresh, empty document for `userId` stamped `updatedAt = now`. */
function emptyMetadata(userId: string, now: string): TagCloudMetadata {
  return {
    userId,
    tags: [],
    taggedFiles: [],
    updatedAt: now,
    version: TAG_METADATA_VERSION,
  };
}

/**
 * An ISO-8601 timestamp with millisecond precision + `Z`, e.g.
 * `2026-06-20T12:34:56.789Z`. `Date.toISOString()` produces EXACTLY this shape
 * (the same the Rust hand-rolls and the app's `DateTime.toIso8601String()` emits
 * for a UTC instant); the app parses it with the liberal `DateTime.parse`.
 */
function nowIso8601(): string {
  return new Date().toISOString();
}

/** The filename a workspace key resolves to: its last `/`-segment (Rust
 *  `filename_of` / `file_name_from_key`). Falls back to the whole key. */
function filenameOfKey(key: string): string {
  const idx = key.lastIndexOf("/");
  const last = idx >= 0 ? key.slice(idx + 1) : key;
  return last.length > 0 ? last : key;
}

/**
 * Tolerantly coerce arbitrary parsed JSON into a `TagCloudMetadata`, defaulting
 * the optional fields exactly as the Dart `fromJson` does (`fileCount ?? 0`,
 * `version ?? '1.0'`, missing tag/file arrays → empty). Throws if the shape is
 * fundamentally wrong (not an object, or a tag/association missing a required
 * non-defaultable field) so a corrupt document is an ERROR — never silently
 * clobbered. Mirrors the Rust serde `#[serde(default)]` tolerance.
 */
function parseTagDocument(raw: unknown): TagCloudMetadata {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tag document is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const tagsIn = Array.isArray(o.tags) ? o.tags : [];
  const filesIn = Array.isArray(o.taggedFiles) ? o.taggedFiles : [];
  const tags: FileTag[] = tagsIn.map((t) => {
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string") {
      throw new Error("tag is missing a required string id/name");
    }
    return {
      id: r.id,
      name: r.name,
      colorValue: typeof r.colorValue === "number" ? r.colorValue : DEFAULT_TAG_COLOR,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
      fileCount: typeof r.fileCount === "number" ? r.fileCount : 0, // Dart `?? 0`
    };
  });
  const taggedFiles: TaggedFile[] = filesIn.map((f) => {
    const r = f as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.tagId !== "string") {
      throw new Error("tagged file is missing a required string id/tagId");
    }
    return {
      id: r.id,
      tagId: r.tagId,
      localPath: typeof r.localPath === "string" ? r.localPath : null,
      remoteKey: typeof r.remoteKey === "string" ? r.remoteKey : null,
      iosAssetId: typeof r.iosAssetId === "string" ? r.iosAssetId : null,
      fileName: typeof r.fileName === "string" ? r.fileName : "",
      taggedAt: typeof r.taggedAt === "string" ? r.taggedAt : "",
    };
  });
  return {
    userId: typeof o.userId === "string" ? o.userId : FALLBACK_USER_ID,
    tags,
    taggedFiles,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
    version: typeof o.version === "string" ? o.version : TAG_METADATA_VERSION, // Dart `?? '1.0'`
  };
}

// Test-only re-exports of the otherwise-internal pure helpers, so the H3b unit
// tests can drive parse + empty-doc construction without the gateway (mirrors how
// the Rust `tags.rs` tests exercise `TagCloudMetadata::empty` / serde parse). Kept
// as named aliases (rather than exporting the bare internals) to mark them test-only.
export const parseTagDocumentForTest = parseTagDocument;
export const emptyMetadataForTest = emptyMetadata;

/**
 * Serialize a document to the EXACT byte shape FxFiles writes. We rebuild every
 * object literal field-by-field in the Dart `toJson` order (NOT spread) so key
 * order is guaranteed regardless of how the in-memory object was constructed, and
 * the nullable association fields are always present as `null`. Compact (no
 * spaces) — the app's `jsonEncode` is also compact. Returns the JSON string.
 */
export function serializeTagDocument(doc: TagCloudMetadata): string {
  const ordered = {
    userId: doc.userId,
    tags: doc.tags.map((t) => ({
      id: t.id,
      name: t.name,
      colorValue: t.colorValue,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      fileCount: t.fileCount,
    })),
    taggedFiles: doc.taggedFiles.map((f) => ({
      id: f.id,
      tagId: f.tagId,
      localPath: f.localPath,
      remoteKey: f.remoteKey,
      iosAssetId: f.iosAssetId,
      fileName: f.fileName,
      taggedAt: f.taggedAt,
    })),
    updatedAt: doc.updatedAt,
    version: doc.version,
  };
  return JSON.stringify(ordered);
}

/** A fresh uuid v4 (hyphenated), matching the Rust `Uuid::new_v4().to_string()`
 *  the app uses for tag/association ids (NOT the hyphen-free `simple()` form). */
function freshUuid(): string {
  return crypto.randomUUID();
}

/**
 * Pure read-modify step (the algorithmic crux; unit-testable, NO network).
 * Applies `tagNames` × `fileKey` to `doc` in place, returning what changed.
 * Mirrors the Rust `apply_tagging`:
 *  - Tags dedupe case-insensitively BY NAME; a new tag keeps the caller's display
 *    casing and gets a fresh uuid + DEFAULT_TAG_COLOR. Names are trimmed; empty/
 *    whitespace names are skipped.
 *  - Associations dedupe by (tagId, remoteKey); an existing (tag, file) pair is
 *    not re-added.
 *  - fileCount is recomputed + updatedAt bumped for exactly the tags that gained
 *    an association (an unchanged tag is left untouched).
 */
export function applyTagging(
  doc: TagCloudMetadata,
  fileKey: string,
  fileName: string,
  tagNames: string[],
  now: string,
): { createdTags: string[]; addedAssociations: number } {
  const createdTags: string[] = [];
  let addedAssociations = 0;
  const touchedTagIds: string[] = [];

  for (const rawName of tagNames) {
    const name = rawName.trim();
    if (name.length === 0) continue; // skip empty/whitespace (the app trims)

    // Find an existing tag by case-insensitive name, else create one.
    const lower = name.toLowerCase();
    let tag = doc.tags.find((t) => t.name.toLowerCase() === lower);
    if (!tag) {
      tag = {
        id: freshUuid(),
        name,
        colorValue: DEFAULT_TAG_COLOR,
        createdAt: now,
        updatedAt: now,
        fileCount: 0,
      };
      doc.tags.push(tag);
      createdTags.push(name);
    }
    const tagId = tag.id;

    // Add the association unless an identical (tagId, remoteKey) already exists.
    const already = doc.taggedFiles.some(
      (tf) => tf.tagId === tagId && tf.remoteKey === fileKey,
    );
    if (!already) {
      doc.taggedFiles.push({
        id: freshUuid(),
        tagId,
        localPath: null,
        remoteKey: fileKey,
        iosAssetId: null,
        fileName,
        taggedAt: now,
      });
      addedAssociations += 1;
      if (!touchedTagIds.includes(tagId)) touchedTagIds.push(tagId);
    }
  }

  // Recompute fileCount + bump updatedAt for exactly the tags that changed.
  for (const tagId of touchedTagIds) {
    const count = doc.taggedFiles.filter((tf) => tf.tagId === tagId).length;
    const tag = doc.tags.find((t) => t.id === tagId);
    if (tag) {
      tag.fileCount = count;
      tag.updatedAt = now;
    }
  }

  return { createdTags, addedAssociations };
}

/** Pure: the logical keys of files associated to `tagName` (case-insensitive) in
 *  `doc`. Resolves the tag(s) by name, then collects their associations'
 *  `remoteKey`s. Used by tag-aware search. Empty if the tag/files are absent. */
export function fileKeysForTagName(doc: TagCloudMetadata, tagName: string): Set<string> {
  const lower = tagName.trim().toLowerCase();
  const tagIds = new Set(
    doc.tags.filter((t) => t.name.toLowerCase() === lower).map((t) => t.id),
  );
  const keys = new Set<string>();
  for (const tf of doc.taggedFiles) {
    if (tagIds.has(tf.tagId) && typeof tf.remoteKey === "string" && tf.remoteKey.length > 0) {
      keys.add(tf.remoteKey);
    }
  }
  return keys;
}

/**
 * Pure search filter (Rust `list.rs::search` semantics): keep entries whose
 * FILENAME (last `/`-segment) contains `query` as a case-insensitive substring;
 * an empty query matches every entry. If `tagKeys` is provided (tag-aware mode),
 * ALSO require the entry's key to be in that set (AND-combined). NO network.
 */
export function searchFilter<T extends { key: string }>(
  entries: T[],
  query: string,
  tagKeys?: Set<string>,
): T[] {
  const needle = query.toLowerCase();
  return entries.filter((e) => {
    if (!filenameOfKey(e.key).toLowerCase().includes(needle)) return false;
    if (tagKeys && !tagKeys.has(e.key)) return false;
    return true;
  });
}

/**
 * Load the AI's tag document from the workspace, or `null` if it does not exist
 * yet. A genuine not-found returns `null` (caller starts fresh); a document that
 * exists but fails to parse THROWS (we never silently clobber it). Mirrors the
 * Rust `load_tag_document` not-found detection (substring check on the error).
 */
async function loadTagDocument(client: EncryptedClient): Promise<TagCloudMetadata | null> {
  let bytes: Uint8Array;
  try {
    bytes = await getFlat(client, WORKSPACE_BUCKET, TAG_METADATA_KEY);
  } catch (e) {
    if (isNotFound(e)) return null; // no document yet → start fresh
    throw e; // a real client/transport error
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (e) {
    throw new CorruptTagDocumentError(
      e instanceof Error ? e.message : "invalid JSON",
    );
  } finally {
    bytes.fill(0);
  }
  try {
    return parseTagDocument(raw);
  } catch (e) {
    throw new CorruptTagDocumentError(e instanceof Error ? e.message : "invalid shape");
  }
}

/** An existing tag document that exists but is not valid TagCloudMetadata JSON.
 *  Distinct from a transport error so we refuse to overwrite a corrupt doc. */
export class CorruptTagDocumentError extends Error {
  constructor(reason: string) {
    super(`existing tag document at '${TAG_METADATA_KEY}' is not valid TagCloudMetadata JSON: ${reason}`);
    this.name = "CorruptTagDocumentError";
  }
}

/** Detect a fula-client "not found" (object missing). The client surfaces errors
 *  as a structured JSON message; we parse defensively + fall back to a substring
 *  check (mirrors the Rust `msg.to_lowercase().contains("not found")`). */
function isNotFound(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  try {
    const parsed = JSON.parse(e.message) as {
      code?: string;
      data?: { status?: number };
      message?: string;
    };
    if (parsed?.data?.status === 404) return true;
    if (parsed?.code === "NOT_FOUND") return true;
    if (typeof parsed?.message === "string" && /not found/i.test(parsed.message)) return true;
  } catch {
    // not JSON — fall through to substring
  }
  return /not found|404|no such key|nosuchkey/i.test(e.message);
}

/** Test-only re-export so the H3b unit tests can pin the not-found DETECTION (the
 *  linchpin of the first-ever tag_file: no doc → start fresh). NOTE this pins our
 *  ASSUMED fula-client error shape against regression; the REAL gateway error is
 *  exercised in H4, not here. */
export const isNotFoundForTest = isNotFound;

/**
 * The shared tag-doc read-modify-write, factored out so BOTH `fula_tag_file` and
 * `fula_store_file`'s auto-tagging drive the SAME path (no duplicated tag-doc
 * logic). Given a live workspace `client`, it loads the document (or starts empty
 * on not-found), applies `tagNames` × the file, bumps `updatedAt`, and writes the
 * document back to TAG_METADATA_KEY in FxFiles' native TagCloudMetadata bytes
 * (last-writer-wins, like the Rust + the app's syncToCloud). Returns what changed.
 *
 * Callers are responsible for scope-validating `fileKey` and for filtering empty
 * tag names up front (mirrors `fula_tag_file`'s pre-checks); a `CorruptTagDocumentError`
 * propagates so each caller can decide how to surface it (a hard error in
 * `fula_tag_file`; a best-effort warning in `fula_store_file`).
 */
async function applyTaggingToDoc(
  client: EncryptedClient,
  userId: string,
  fileKey: string,
  tagNames: string[],
  now: string,
): Promise<TagOutcome> {
  const existing = await loadTagDocument(client);
  const doc = existing ?? emptyMetadata(userId.length > 0 ? userId : FALLBACK_USER_ID, now);
  const fileName = filenameOfKey(fileKey);
  const { createdTags, addedAssociations } = applyTagging(doc, fileKey, fileName, tagNames, now);
  // Always bump updatedAt to reflect this call (matches the app's syncToCloud).
  doc.updatedAt = now;
  const json = serializeTagDocument(doc);
  await putFlat(
    client,
    WORKSPACE_BUCKET,
    TAG_METADATA_KEY,
    new TextEncoder().encode(json),
    "application/json",
  );
  return { metadata: doc, createdTags, addedAssociations } satisfies TagOutcome;
}

// ── Tool: fula_tag_file ──────────────────────────────────────────────────────
export interface TagFileArgs {
  key: string;
  tags: string[];
}

/**
 * Tag a stored workspace file with one or more tags, writing the result into the
 * AI's tag document in FxFiles' native TagCloudMetadata format. Read-modify-write
 * (last-writer-wins, like the Rust + the app's syncToCloud): load the document
 * (or start empty on not-found), upsert tags + associations, write it back.
 *
 * The file `key` is scope-validated up front (defense in depth; the gateway also
 * scopes the bucket). The doc key itself is fixed + under `ai/`.
 */
export async function tagFile(
  env: CapabilityEnv,
  userId: string,
  args: TagFileArgs,
): Promise<ToolResult> {
  const fileKey = args.key;
  if (!isInWorkspaceScope(fileKey)) {
    return err(`key '${fileKey}' is not inside the ai/ workspace scope`);
  }
  // Match the Rust: refuse a no-op (no names) rather than a pointless round-trip.
  const names = Array.isArray(args.tags) ? args.tags : [];
  if (names.length === 0 || names.every((n) => n.trim().length === 0)) {
    return err("fula_tag_file requires at least one non-empty tag name");
  }

  const now = nowIso8601();
  try {
    const outcome = await withWorkspaceClient(env, userId, async (client) => {
      return applyTaggingToDoc(client, userId, fileKey, names, now);
    });
    await recordAudit(env.CUSTODY_DB, userId, "mcp_tag_file", {
      key: fileKey,
      created_tags: outcome.createdTags.length,
      added_associations: outcome.addedAssociations,
    });
    return ok({
      key: fileKey,
      bucket: WORKSPACE_BUCKET,
      metadata_key: TAG_METADATA_KEY,
      created_tags: outcome.createdTags,
      added_associations: outcome.addedAssociations,
      total_tags: outcome.metadata.tags.length,
    });
  } catch (e) {
    if (e instanceof CorruptTagDocumentError) return err(e.message);
    return err(toolErrorMessage(e, "tag_file"));
  }
}

// ── Tool: fula_list_tags ─────────────────────────────────────────────────────
/** List all tags in the AI's tag document (empty if the document does not exist). */
export async function listTags(env: CapabilityEnv, userId: string): Promise<ToolResult> {
  try {
    const tags = await withWorkspaceClient(env, userId, async (client) => {
      const doc = await loadTagDocument(client);
      return doc ? doc.tags : [];
    });
    return ok({ bucket: WORKSPACE_BUCKET, metadata_key: TAG_METADATA_KEY, count: tags.length, tags });
  } catch (e) {
    if (e instanceof CorruptTagDocumentError) return err(e.message);
    return err(toolErrorMessage(e, "list_tags"));
  }
}

// ── Tool: fula_search ────────────────────────────────────────────────────────
export interface SearchArgs {
  query: string;
  /** Optional tag-name filter (hosted superset; AND-combined with `query`). When
   *  omitted, behavior is identical to the local Rust `fula_search(query)`. */
  tag?: string;
}

/**
 * Search the AI's workspace by FILENAME substring (case-insensitive; empty query
 * matches all) — the Rust `list.rs::search` contract — optionally AND-filtered by
 * a tag name (hosted superset, resolved via the tag-metadata doc). Reuses the same
 * scope-confined listing as fula_list_files.
 */
export async function search(
  env: CapabilityEnv,
  userId: string,
  args: SearchArgs,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query : "";
  const tagName = typeof args.tag === "string" ? args.tag.trim() : "";
  try {
    const files = await withWorkspaceClient(env, userId, async (client) => {
      const rows = await listFilesFromForest(client, WORKSPACE_BUCKET);
      // Confine EVERY entry by the same segment geometry as fula_list_files
      // (treat the listing as untrusted — never let a non-ai/ key leak through).
      const confined = rows
        .map(toListEntry)
        .filter((f): f is ListEntry => f !== null && isInWorkspaceScope(f.key));
      // Resolve the optional tag filter from the tag-metadata doc (only when asked).
      let tagKeys: Set<string> | undefined;
      if (tagName.length > 0) {
        const doc = await loadTagDocument(client);
        tagKeys = doc ? fileKeysForTagName(doc, tagName) : new Set<string>();
      }
      return searchFilter(confined, query, tagKeys);
    });
    return ok({ bucket: WORKSPACE_BUCKET, query, tag: tagName || undefined, count: files.length, files });
  } catch (e) {
    if (e instanceof CorruptTagDocumentError) return err(e.message);
    return err(toolErrorMessage(e, "search"));
  }
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
