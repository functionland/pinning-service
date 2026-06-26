/**
 * The collaboration MCP tools — store / read / list / search / create_folder /
 * remove, operating over ONE collaboration GROUP. Worker (TS) port of the Rust
 * `crates/fula-mcp/src/{store,read,list}.rs`.
 *
 * Every tool operates on a {@link CollabSession} (the per-connection bundle, with
 * the link secret already recovered and the write-token refresh wired in). There
 * is no `ai/` workspace scope and no per-user workspace secret: authorization is
 * "the file is in THIS group's manifest" (the session is per-group).
 *
 * ## Commit protocol (merge-on-write + optional compare-and-swap)
 *
 * The manifest PUT is last-writer-wins, so a naive overwrite would clobber a
 * concurrent human edit. Each write therefore (mirroring the Rust commit):
 *  1. fetches the current manifest (the operation base);
 *  2. clones it and applies its purely-ADDITIVE change → `local`;
 *  3. fetches the manifest AGAIN, fresh → `remote` (+ its server version);
 *  4. computes `mergeWith(remote, local)` — `remote` is the receiver so a
 *     concurrent human edit to an existing entry wins, while the AI's brand-new
 *     entry (a fresh UUID only in `local`) is unioned in;
 *  5. re-encrypts (`ENC1:`) and PUTs with `If-Match: <remote server version>` —
 *     a 409 (the version moved between steps 3–5) re-runs from step 3 (bounded),
 *     CLOSING the lost-update window the Rust left as a follow-up. A write-token
 *     401/403 refreshes the token and retries once.
 *
 * `remove` is a manifest TOMBSTONE (never the global server DELETE). `store`
 * uploads the blob BEFORE the manifest commit; a failed commit leaves an
 * unreferenced (harmless) orphan blob — never deleted.
 */

import { classify, type Category } from "../classify.js";
import {
  collabFileDecrypt,
  collabFileEncrypt,
  enc1Encrypt,
} from "./crypto.js";
import {
  CollabError,
  fetchCollabFile,
  fetchManifest,
  putManifest,
  uploadCollabFile,
} from "./client.js";
import {
  cloneManifest,
  mergeWith,
  serializeManifest,
  type CollaborationFile,
  type CollaborationGroup,
} from "./manifest.js";
import { withCollabWriteRetry, type WriteTokenContext } from "./refresh.js";
import {
  DIRECTORY_CONTENT_TYPE,
  isDirectory,
  isTombstoned,
  liveFiles,
  logicalPathOf,
  normalizeFolder,
  pathUnderFolder,
} from "./tree.js";

/** A tool result the MCP layer understands (structurally a `CallToolResult`). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [x: string]: unknown;
}

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
function err(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The per-connection collaboration session a tool runs against. Built from the
 * delivered bundle + the Worker's recovered link secret (see ../../capability /
 * the collab custody). It also satisfies {@link WriteTokenContext} so the write
 * helpers can refresh the Bearer in place.
 */
export interface CollabSession extends WriteTokenContext {
  /** Injectable fetch (the global in production; a stub in tests). */
  fetchImpl: typeof fetch;
  /** Base URL for the `/api/collab/*` endpoints (no trailing slash). */
  webuiBase: string;
  /** The collaboration group UUID. */
  groupId: string;
  /** Default bucket stamped on collab files the AI writes (informational). */
  manifestBucket: string;
  /** The recovered 32-byte group link secret. */
  linkSecret: Uint8Array;
  /** The Worker identity's base64 public key — stamped as `addedByPublicKey`. */
  mcpPublicB64: string;
}

/** Max compare-and-swap retries when the manifest version moves mid-commit. */
const MAX_CAS_RETRIES = 4;

/** ISO-8601 millisecond UTC, the shape the Dart manifest uses + the naive parser understands. */
function nowIso(): string {
  return new Date().toISOString();
}

/** A fresh hyphenated UUID v4 (manifest ids, matching the Dart/Rust uuid form). */
function freshUuid(): string {
  return crypto.randomUUID();
}

/** Map an internal error to a terse, non-secret tool message. */
function toolErrorMessage(e: unknown, op: string): string {
  if (e instanceof CollabError) {
    if (e.kind === "writeNotConfigured") {
      return "This AI connection is read-only for this group (no collab write token was delivered).";
    }
    if (e.kind === "auth") {
      return "The collaboration write authorization was rejected (the token may be expired or revoked).";
    }
    if (e.kind === "unauthenticatedManifest") {
      return "Refusing to trust an unauthenticated group manifest.";
    }
    return `${op} failed: ${e.message}`;
  }
  if (e instanceof Error) return `${op} failed: ${e.message}`;
  return `${op} failed`;
}

// ── commit protocol ──────────────────────────────────────────────────────────

/** Sleep with jittered exponential backoff to break a 409 herd. */
function backoff(attempt: number): Promise<void> {
  const base = Math.min(40 * 2 ** attempt, 320);
  return new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * 40)));
}

/**
 * Apply an additive `mutate` to a clone of `base`, then (bounded) GET-fresh +
 * merge + PUT with compare-and-swap. Returns the merged manifest.
 */
async function commitManifestChange(
  session: CollabSession,
  base: CollaborationGroup,
  baseVersion: number,
  mutate: (m: CollaborationGroup) => void,
): Promise<CollaborationGroup> {
  const local = cloneManifest(base);
  mutate(local);

  let remote = base;
  let remoteVersion: number | undefined = baseVersion;
  for (let attempt = 0; ; attempt++) {
    // GET-latest, fresh, just before the PUT (skip on attempt 0 — `base` IS fresh
    // for the first try; re-GET only after a conflict).
    if (attempt > 0) {
      const fresh = await fetchManifest(session.fetchImpl, session.webuiBase, session.groupId, session.linkSecret);
      remote = fresh?.group ?? base;
      remoteVersion = fresh?.version;
    }
    // remote == receiver ⇒ wins on existing-id conflict; local's additive entry
    // is unioned in. See the module docs for why this ordering.
    const merged = mergeWith(remote, local, nowIso());
    const enc1 = await enc1Encrypt(new TextEncoder().encode(serializeManifest(merged)), session.linkSecret, session.groupId);
    try {
      await withCollabWriteRetry(session, (tok) =>
        putManifest(session.fetchImpl, session.webuiBase, session.groupId, tok, enc1, remoteVersion),
      );
      return merged;
    } catch (e) {
      if (e instanceof CollabError && e.kind === "conflict" && attempt < MAX_CAS_RETRIES) {
        await backoff(attempt);
        continue; // re-GET (fresh server version), re-merge, retry
      }
      throw e;
    }
  }
}

/** Fetch the group's current manifest, erroring if it does not exist yet. */
async function fetchBase(session: CollabSession): Promise<{ group: CollaborationGroup; version: number }> {
  const fresh = await fetchManifest(session.fetchImpl, session.webuiBase, session.groupId, session.linkSecret);
  if (!fresh) {
    throw new CollabError("notFound", "the group manifest is not initialized; cannot write");
  }
  return fresh;
}

// ── store_file ───────────────────────────────────────────────────────────────

export interface StoreArgs {
  /** Decoded plaintext bytes to store. */
  data: Uint8Array;
  fileName: string;
  mime?: string;
  /** Text payload (used only for category classification). */
  text?: string;
  /** Containing folder, e.g. `/notes` (omit/`/` for the group root). */
  subfolder?: string;
  category?: Category;
}

/**
 * Store a file into the group: classify it, encrypt it under the per-file collab
 * key, upload the blob, and append a `collab` manifest entry (merge-committed).
 */
export async function storeFile(session: CollabSession, args: StoreArgs): Promise<ToolResult> {
  const fileName = sanitizeFileName(args.fileName);
  if (fileName === null) return err("filename is empty");
  let pathScope: string | null;
  try {
    pathScope = args.subfolder ? normalizeFolder(args.subfolder) : null;
  } catch (e) {
    return err(`invalid subfolder: ${e instanceof Error ? e.message : "?"}`);
  }
  const category = args.category ?? classify(args.mime, fileName, args.text);

  if (session.collabWriteToken() === undefined) {
    return err(toolErrorMessage(new CollabError("writeNotConfigured", ""), "store"));
  }

  try {
    // Fetch the base BEFORE uploading so a missing group fails without orphaning a blob.
    const { group: base, version } = await fetchBase(session);

    const fileId = freshUuid();
    const blob = await collabFileEncrypt(args.data, session.linkSecret, fileId);

    const uploaded = await withCollabWriteRetry(session, (tok) =>
      uploadCollabFile(session.fetchImpl, session.webuiBase, session.groupId, tok, fileId, blob),
    );

    const bucket = uploaded.bucket && uploaded.bucket.length > 0 ? uploaded.bucket : session.manifestBucket;
    const storageKey =
      uploaded.storageKey && uploaded.storageKey.length > 0
        ? uploaded.storageKey
        : `.fula/collab/${session.groupId}/files/${fileId}`;

    const entry: CollaborationFile = {
      id: fileId,
      fileName,
      bucket,
      storageKey,
      addedByPublicKey: session.mcpPublicB64,
      addedAt: nowIso(),
      fileSize: args.data.length,
      encType: "collab",
    };
    if (args.mime) entry.contentType = args.mime;
    if (pathScope) entry.pathScope = pathScope;
    const path = logicalPathOf(entry);

    const merged = await commitManifestChange(session, base, version, (m) => m.files.push(entry));

    return ok({
      file_id: fileId,
      file_name: fileName,
      path,
      category,
      bucket,
      storage_key: storageKey,
      size: args.data.length,
      enc_type: "collab",
      manifest_version: merged.version,
      group_id: session.groupId,
    });
  } catch (e) {
    return err(toolErrorMessage(e, "store"));
  }
}

// ── create_folder ────────────────────────────────────────────────────────────

export async function createFolder(session: CollabSession, path: string): Promise<ToolResult> {
  if (session.collabWriteToken() === undefined) {
    return err(toolErrorMessage(new CollabError("writeNotConfigured", ""), "create_folder"));
  }
  let folder: string | null;
  try {
    folder = normalizeFolder(path);
  } catch (e) {
    return err(`invalid folder path: ${e instanceof Error ? e.message : "?"}`);
  }
  if (folder === null) return err("cannot create the group root as a folder");
  const leaf = folder.split("/").pop() ?? "";

  try {
    const { group: base, version } = await fetchBase(session);
    const marker: CollaborationFile = {
      id: freshUuid(),
      fileName: leaf,
      contentType: DIRECTORY_CONTENT_TYPE,
      bucket: session.manifestBucket,
      storageKey: "",
      pathScope: folder,
      addedByPublicKey: session.mcpPublicB64,
      addedAt: nowIso(),
      fileSize: 0,
      encType: "collab",
    };
    const merged = await commitManifestChange(session, base, version, (m) => m.files.push(marker));
    return ok({ path: folder, manifest_version: merged.version, group_id: session.groupId });
  } catch (e) {
    return err(toolErrorMessage(e, "create_folder"));
  }
}

// ── remove_file (tombstone — NEVER a server DELETE) ──────────────────────────

export async function removeFile(session: CollabSession, fileId: string): Promise<ToolResult> {
  if (session.collabWriteToken() === undefined) {
    return err(toolErrorMessage(new CollabError("writeNotConfigured", ""), "remove"));
  }
  const id = fileId.trim();
  if (id.length === 0) return err("file_id is empty");

  try {
    const { group: base, version } = await fetchBase(session);
    const found = base.files.find((f) => f.id === id);
    const removedPath = found ? logicalPathOf(found) : undefined;
    const merged = await commitManifestChange(session, base, version, (m) => {
      if (!m.removedFileIds.includes(id)) m.removedFileIds.push(id);
      m.files = m.files.filter((f) => f.id !== id);
    });
    return ok({
      file_id: id,
      removed_path: removedPath,
      manifest_version: merged.version,
      group_id: session.groupId,
      note: "Removed from the group manifest (tombstone). The encrypted object is not deleted.",
    });
  } catch (e) {
    return err(toolErrorMessage(e, "remove"));
  }
}

// ── read_file ────────────────────────────────────────────────────────────────

export interface ReadArgs {
  fileId?: string;
  path?: string;
}

/** Resolve a read target to a live (non-tombstoned, non-directory) entry. */
function resolveEntry(manifest: CollaborationGroup, args: ReadArgs): CollaborationFile | { error: string } {
  if (args.fileId && args.fileId.trim().length > 0) {
    const id = args.fileId.trim();
    const f = manifest.files.find((x) => x.id === id && !isTombstoned(manifest, x.id) && !isDirectory(x));
    return f ?? { error: `no file with id \`${id}\`` };
  }
  if (args.path && args.path.trim().length > 0) {
    const raw = args.path.trim();
    let want: string | null;
    try {
      want = normalizeFolder(raw);
    } catch (e) {
      return { error: `invalid path: ${e instanceof Error ? e.message : "?"}` };
    }
    if (want === null) return { error: "path resolves to the group root (not a file)" };
    const f = manifest.files
      .filter((x) => !isTombstoned(manifest, x.id) && !isDirectory(x))
      .find((x) => logicalPathOf(x) === want || x.fileName === raw);
    return f ?? { error: `no file at path \`${want}\`` };
  }
  return { error: "provide either file_id or path" };
}

/**
 * Read + decrypt a file in the group, addressed by id or path. Collab-encrypted
 * files are fully supported. Owner `fula`-encrypted files are NOT yet readable via
 * the hosted Worker — see the PR notes (the same fula-client binding gap as the
 * link-secret unwrap).
 */
export async function readFile(session: CollabSession, args: ReadArgs): Promise<ToolResult> {
  try {
    const fresh = await fetchManifest(session.fetchImpl, session.webuiBase, session.groupId, session.linkSecret);
    if (!fresh) return err("the group has no manifest");
    const resolved = resolveEntry(fresh.group, args);
    if ("error" in resolved) return err(resolved.error);
    const file = resolved;

    if (file.encType === "collab") {
      const blob = await fetchCollabFile(session.fetchImpl, session.webuiBase, session.groupId, file.id);
      const plaintext = await collabFileDecrypt(blob, session.linkSecret, file.id);
      return ok({
        file_id: file.id,
        file_name: file.fileName,
        path: logicalPathOf(file),
        content_type: file.contentType,
        enc_type: "collab",
        size: plaintext.length,
        encoding: "base64",
        content: base64Of(plaintext),
        group_id: session.groupId,
      });
    }

    if (file.encType === "fula") {
      // Owner fula-encrypted file: needs the fula-client share-decryption path
      // (accept_share → AcceptedShare.dek/nonce + the fula:v4 AAD), which the
      // pinned WASM only exposes as an OPAQUE handle (no DEK access), and whose
      // `getWithToken` endpoint shape does not match `/fula-fetch?bucket=&key=`.
      // Deferred — the SAME upstream binding gap as the link-secret unwrap.
      return err(
        "This file was added by the FxFiles owner (fula-encrypted). Reading owner files via the " +
          "hosted MCP is not yet available (needs a fula-client share-DEK binding — see the PR notes). " +
          "Collab files the AI stored ARE readable.",
      );
    }
    return err(`unknown encType \`${file.encType}\``);
  } catch (e) {
    return err(toolErrorMessage(e, "read"));
  }
}

// ── list_files ───────────────────────────────────────────────────────────────

export interface ListArgs {
  folder?: string;
  category?: Category;
  includeDirectories?: boolean;
}

interface FileEntry {
  file_id: string;
  file_name: string;
  path: string;
  is_directory: boolean;
  category: Category;
  content_type?: string;
  enc_type: string;
  size: number;
  added_by_public_key: string;
  added_at: string;
}

function entryOf(f: CollaborationFile, path: string, isDir: boolean, category: Category): FileEntry {
  const e: FileEntry = {
    file_id: f.id,
    file_name: f.fileName,
    path,
    is_directory: isDir,
    category,
    enc_type: f.encType,
    size: f.fileSize,
    added_by_public_key: f.addedByPublicKey,
    added_at: f.addedAt,
  };
  if (f.contentType !== undefined) e.content_type = f.contentType;
  return e;
}

/** List the group's files (and, if requested, folder markers), applying filters. */
export async function listFiles(session: CollabSession, args: ListArgs): Promise<ToolResult> {
  try {
    const fresh = await fetchManifest(session.fetchImpl, session.webuiBase, session.groupId, session.linkSecret);
    const files: FileEntry[] = [];
    if (fresh) {
      let folder: string | null = null;
      if (args.folder) {
        try {
          folder = normalizeFolder(args.folder);
        } catch (e) {
          return err(`invalid folder: ${e instanceof Error ? e.message : "?"}`);
        }
      }
      for (const f of liveFiles(fresh.group)) {
        const isDir = isDirectory(f);
        if (isDir && !args.includeDirectories) continue;
        const path = logicalPathOf(f);
        if (args.folder && !pathUnderFolder(path, args.folder)) continue;
        const category = classify(f.contentType, f.fileName, undefined);
        if (args.category !== undefined && (isDir || category !== args.category)) continue;
        files.push(entryOf(f, path, isDir, category));
      }
    }
    return ok({ group_id: session.groupId, count: files.length, files });
  } catch (e) {
    return err(toolErrorMessage(e, "list"));
  }
}

// ── search ───────────────────────────────────────────────────────────────────

/** Search the group's files by filename / path substring (case-insensitive). An
 *  empty query returns nothing (mirrors the Rust `search_in`). */
export async function search(session: CollabSession, query: string): Promise<ToolResult> {
  try {
    const needle = (query ?? "").trim().toLowerCase();
    const files: FileEntry[] = [];
    if (needle.length > 0) {
      const fresh = await fetchManifest(session.fetchImpl, session.webuiBase, session.groupId, session.linkSecret);
      if (fresh) {
        for (const f of liveFiles(fresh.group)) {
          if (isDirectory(f)) continue;
          const path = logicalPathOf(f);
          if (f.fileName.toLowerCase().includes(needle) || path.toLowerCase().includes(needle)) {
            files.push(entryOf(f, path, false, classify(f.contentType, f.fileName, undefined)));
          }
        }
      }
    }
    return ok({ group_id: session.groupId, query: needle, count: files.length, files });
  } catch (e) {
    return err(toolErrorMessage(e, "search"));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Sanitize a display filename: trim, strip path separators / NUL; null if empty. */
function sanitizeFileName(raw: string): string | null {
  let out = "";
  for (const ch of raw.trim()) {
    if (ch === "/" || ch === "\\" || ch === "\0") continue;
    out += ch;
  }
  out = out.trim();
  return out.length > 0 ? out : null;
}

function base64Of(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
