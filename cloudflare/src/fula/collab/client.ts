/**
 * Collaboration HTTP client (`/api/collab/{group_id}/*`) — Worker (TS) port of
 * the Rust `crates/fula-mcp/src/collab.rs`, talking to the SAME pinning-webui
 * collaboration routes the FxFiles app + web portal use.
 *
 * This module owns ONLY the HTTP framing + JSON envelopes; every byte of crypto
 * is delegated to ./crypto.ts (the `ENC1:` manifest envelope + collab-file
 * blobs). Owner-file (`encType:"fula"`) decryption is wired in ./tools.ts (it
 * accepts the per-file v5 ShareToken with the 0.6.19 recipient bindings); this
 * module only FETCHES the ciphertext (see `fulaFetch`).
 *
 * ## Endpoints
 *
 * READ (no auth — the group id is the link capability):
 *  - `GET  {base}/api/collab/{group}/manifest-sync`
 *      → `{ encryptedManifest: "ENC1:…", version }` | `{ data: "ENC1:…", version }`
 *      (HTTP 404 ⇒ the group has no manifest yet ⇒ `null`).
 *  - `GET  {base}/api/collab/{group}/file/{fileId}` → raw collab-file blob.
 *  - `GET  {base}/api/collab/{group}/fula-fetch?bucket=&key=` → owner-file bytes.
 *
 * WRITE (Bearer `collab_write_token`):
 *  - `PUT  {base}/api/collab/{group}/manifest-sync` body `{encryptedManifest}`,
 *      optional `If-Match: "<version>"` (compare-and-swap). 409 ⇒ version moved.
 *  - `POST {base}/api/collab/{group}/upload` header `x-collab-file-id: {uuid}`,
 *      `Content-Type: application/octet-stream`, body = the collab-file blob.
 *
 * The server-side `DELETE /file/:fileId` is NEVER called — the AI removes its
 * files by writing a TOMBSTONE into the manifest (see ./tools.ts removeFile); the
 * object delete is global/irreversible and would break other group members.
 */

import { enc1Decrypt, ENC1_PREFIX } from "./crypto.js";
import { parseManifest, type CollaborationGroup } from "./manifest.js";

/** Maximum bytes we will buffer for a manifest-sync response (OOM guard). The
 *  manifest is a file index, not file data, so 16 MiB is generous. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** Maximum bytes we will buffer for a single file fetch (collab blob / owner-file
 *  ciphertext or one chunk). Bounds the ~3x read-path expansion (ct + plaintext +
 *  base64) against the isolate memory ceiling; collab files the AI stores are below
 *  the content store cap, and owner files are read one chunk at a time. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Discriminated error kinds for the collab HTTP client. */
export type CollabErrorKind =
  | "transport"
  | "status"
  | "auth"
  | "writeNotConfigured"
  | "notFound"
  | "decrypt"
  | "json"
  | "emptyManifest"
  | "unauthenticatedManifest"
  | "tooLarge"
  | "conflict";

/** A collaboration HTTP / manifest failure. Carries no secret. */
export class CollabError extends Error {
  constructor(
    readonly kind: CollabErrorKind,
    message: string,
    /** HTTP status for `status`/`auth`/`conflict`. */
    readonly status?: number,
    /** The server's current manifest version on a `conflict` (409). */
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "CollabError";
  }
}

/** A manifest GET result: the decrypted group + its server version (for CAS). */
export interface FetchedManifest {
  group: CollaborationGroup;
  /** The server's `version` for this manifest (drives `If-Match` on a PUT). */
  version: number;
}

/** The upload response (all fields optional — collab reads address by fileId). */
export interface UploadResponse {
  storageKey?: string;
  bucket?: string;
  fileId?: string;
  size?: number;
}

// ── URL helpers ──────────────────────────────────────────────────────────────

function collabBase(webuiBase: string, groupId: string): string {
  return `${webuiBase.replace(/\/+$/, "")}/api/collab/${encodeURIComponent(groupId)}`;
}

// ── Manifest payload parsing (pure — unit-tested without HTTP) ────────────────

/**
 * Decode a manifest-sync payload string into a {@link CollaborationGroup}.
 *
 * SECURITY: the body MUST be an `ENC1:` (link-secret-authenticated) envelope — an
 * unauthenticated plaintext manifest is REJECTED. Trusting plaintext would let a
 * malicious/compromised server forge the file listing, which the merge-on-write
 * would then launder into an authenticated re-PUT. The Worker holds the link
 * secret and current clients always write `ENC1:`.
 */
export async function parseManifestPayload(
  raw: string,
  linkSecret: Uint8Array,
  groupId: string,
): Promise<CollaborationGroup> {
  if (!raw.startsWith(ENC1_PREFIX)) {
    throw new CollabError(
      "unauthenticatedManifest",
      "manifest is not an authenticated ENC1 envelope (refusing unauthenticated manifest)",
    );
  }
  const plain = await enc1Decrypt(raw, linkSecret, groupId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain));
  } catch (e) {
    throw new CollabError("json", `manifest JSON parse error: ${e instanceof Error ? e.message : "bad json"}`);
  }
  return parseManifest(parsed);
}

// ── READ (no auth) ───────────────────────────────────────────────────────────

/**
 * `GET manifest-sync` → decrypt → {@link FetchedManifest}. Returns `null` when
 * the group has no manifest yet (HTTP 404).
 */
export async function fetchManifest(
  fetchImpl: typeof fetch,
  webuiBase: string,
  groupId: string,
  linkSecret: Uint8Array,
): Promise<FetchedManifest | null> {
  const url = `${collabBase(webuiBase, groupId)}/manifest-sync`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, { method: "GET" });
  } catch (e) {
    throw new CollabError("transport", `collab HTTP transport error: ${errMsg(e)}`);
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new CollabError("status", `collab endpoint manifest-sync(GET) returned HTTP ${resp.status}`, resp.status);
  }
  const text = await readCappedText(resp, "manifest-sync(GET)");
  let body: { encryptedManifest?: unknown; data?: unknown; version?: unknown };
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new CollabError("json", `collab JSON parse error: ${errMsg(e)}`);
  }
  const raw =
    typeof body.encryptedManifest === "string" && body.encryptedManifest
      ? body.encryptedManifest
      : typeof body.data === "string" && body.data
        ? body.data
        : null;
  if (raw === null) {
    throw new CollabError("emptyManifest", "manifest-sync response had neither `encryptedManifest` nor `data`");
  }
  const group = await parseManifestPayload(raw, linkSecret, groupId);
  const version = typeof body.version === "number" ? body.version : group.version;
  return { group, version };
}

/** `GET file/{fileId}` → the raw collab-file blob (`nonce||ct||tag`). */
export async function fetchCollabFile(
  fetchImpl: typeof fetch,
  webuiBase: string,
  groupId: string,
  fileId: string,
): Promise<Uint8Array> {
  const url = `${collabBase(webuiBase, groupId)}/file/${encodeURIComponent(fileId)}`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, { method: "GET" });
  } catch (e) {
    throw new CollabError("transport", `collab HTTP transport error: ${errMsg(e)}`);
  }
  if (resp.status === 404) throw new CollabError("notFound", `collab object not found: collab file ${fileId}`);
  if (!resp.ok) throw new CollabError("status", `collab endpoint file(GET) returned HTTP ${resp.status}`, resp.status);
  return readCappedBytes(resp, MAX_FILE_BYTES, "file(GET)");
}

/**
 * `GET fula-fetch?bucket=&key=` → an owner's fula-encrypted object bytes. For a
 * single-block file this is the whole ciphertext; for a chunked file it is called
 * once per chunk with `key = "{storageKey}.chunks/{i:08}"`.
 */
export async function fulaFetch(
  fetchImpl: typeof fetch,
  webuiBase: string,
  groupId: string,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const u = new URL(`${collabBase(webuiBase, groupId)}/fula-fetch`);
  u.searchParams.set("bucket", bucket);
  u.searchParams.set("key", key);
  let resp: Response;
  try {
    resp = await fetchImpl(u.toString(), { method: "GET" });
  } catch (e) {
    throw new CollabError("transport", `collab HTTP transport error: ${errMsg(e)}`);
  }
  if (resp.status === 404) throw new CollabError("notFound", `collab object not found: owner object ${bucket}/${key}`);
  if (!resp.ok) {
    throw new CollabError("status", `collab endpoint fula-fetch(GET) returned HTTP ${resp.status}`, resp.status);
  }
  return readCappedBytes(resp, MAX_FILE_BYTES, "fula-fetch(GET)");
}

// ── WRITE (Bearer collab_write_token) ────────────────────────────────────────

/**
 * `PUT manifest-sync` body `{"encryptedManifest": enc1}` (Bearer). When
 * `baseVersion` is supplied, an `If-Match: "<baseVersion>"` precondition makes the
 * write a compare-and-swap: a 409 (the stored version moved) surfaces as
 * {@link CollabError} kind `"conflict"` carrying `currentVersion`. A 401/403
 * surfaces as kind `"auth"` so the caller can refresh + retry once. Returns the
 * new manifest version reported by the server (best-effort).
 */
export async function putManifest(
  fetchImpl: typeof fetch,
  webuiBase: string,
  groupId: string,
  writeToken: string,
  enc1: string,
  baseVersion?: number,
): Promise<number | undefined> {
  const url = `${collabBase(webuiBase, groupId)}/manifest-sync`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${writeToken}`,
    "content-type": "application/json",
  };
  if (baseVersion !== undefined) headers["if-match"] = `"${baseVersion}"`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ encryptedManifest: enc1 }),
    });
  } catch (e) {
    throw new CollabError("transport", `collab HTTP transport error: ${errMsg(e)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new CollabError("auth", `collab write authorization rejected (HTTP ${resp.status})`, resp.status);
  }
  if (resp.status === 409) {
    const cur = await currentVersionFrom(resp);
    throw new CollabError("conflict", "manifest version conflict", 409, cur);
  }
  if (!resp.ok) {
    throw new CollabError("status", `collab endpoint manifest-sync(PUT) returned HTTP ${resp.status}`, resp.status);
  }
  return versionFromOkResponse(resp);
}

/** `POST upload` with the collab-file blob (Bearer + `x-collab-file-id`). A
 *  401/403 surfaces as kind `"auth"` for refresh-and-retry. */
export async function uploadCollabFile(
  fetchImpl: typeof fetch,
  webuiBase: string,
  groupId: string,
  writeToken: string,
  fileId: string,
  blob: Uint8Array,
): Promise<UploadResponse> {
  const url = `${collabBase(webuiBase, groupId)}/upload`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${writeToken}`,
        "content-type": "application/octet-stream",
        "x-collab-file-id": fileId,
      },
      body: blob,
    });
  } catch (e) {
    throw new CollabError("transport", `collab HTTP transport error: ${errMsg(e)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new CollabError("auth", `collab write authorization rejected (HTTP ${resp.status})`, resp.status);
  }
  if (!resp.ok) {
    throw new CollabError("status", `collab endpoint upload(POST) returned HTTP ${resp.status}`, resp.status);
  }
  try {
    return (await resp.json()) as UploadResponse;
  } catch (e) {
    throw new CollabError("json", `collab JSON parse error: ${errMsg(e)}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Read a response body as text with a streaming OOM cap. */
async function readCappedText(resp: Response, what: string): Promise<string> {
  return new TextDecoder("utf-8").decode(await readBodyCapped(resp, MAX_MANIFEST_BYTES, what));
}

/** Read a binary response body with a streaming OOM cap. */
async function readCappedBytes(resp: Response, max: number, what: string): Promise<Uint8Array> {
  return readBodyCapped(resp, max, what);
}

/**
 * Read a response body under a hard byte cap, STREAMING — an over-cap body is
 * aborted mid-flight (`reader.cancel`) instead of being fully buffered first. A
 * lying or ABSENT `Content-Length` therefore cannot defeat the cap: the previous
 * `arrayBuffer()` path allocated the ENTIRE body before the size check, so a
 * compromised/malicious server could OOM the isolate well past the cap (GLM-5.2
 * review, HIGH). The Content-Length precheck is kept as a fast reject for an
 * honest oversized header. Exported for the unit test. */
export async function readBodyCapped(resp: Response, max: number, what: string): Promise<Uint8Array> {
  const len = Number(resp.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > max) {
    throw new CollabError("tooLarge", `collab ${what} response exceeded the ${max}-byte cap`);
  }
  const body = resp.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        // Never buffer past the cap — stop pulling bytes immediately.
        await reader.cancel().catch(() => {});
        throw new CollabError("tooLarge", `collab ${what} response exceeded the ${max}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released/cancelled */
    }
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Parse the `currentVersion` off a 409 body / ETag (best-effort). */
async function currentVersionFrom(resp: Response): Promise<number | undefined> {
  try {
    const body = (await resp.json()) as { currentVersion?: unknown };
    if (typeof body.currentVersion === "number") return body.currentVersion;
  } catch {
    /* fall through to ETag */
  }
  return etagVersion(resp);
}

/** Parse the new version off a 2xx manifest-sync body / ETag (best-effort). */
async function versionFromOkResponse(resp: Response): Promise<number | undefined> {
  try {
    const body = (await resp.json()) as { version?: unknown };
    if (typeof body.version === "number") return body.version;
  } catch {
    /* fall through to ETag */
  }
  return etagVersion(resp);
}

/** Parse a numeric version out of a `"<n>"` ETag header. */
function etagVersion(resp: Response): number | undefined {
  const etag = resp.headers.get("etag");
  if (!etag) return undefined;
  const n = Number(etag.replace(/^W\//i, "").replace(/^"(.*)"$/, "$1"));
  return Number.isFinite(n) ? n : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
