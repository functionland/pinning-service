/**
 * Collaboration tools end-to-end against a MOCKED `/api/collab/*` server with an
 * INJECTED known link secret (no HPKE unwrap, no real gateway). This drives the
 * real `storeFile` / `readFile` / `listFiles` / `search` / `createFolder` /
 * `removeFile` orchestration + the merge-on-write commit, mocking exactly the HTTP
 * seam the tool bodies cross. The collab-file + manifest crypto is REAL (the
 * server stores ENC1 manifests + nonce||ct||tag blobs the same way production
 * does), so a store→read round-trip exercises the full encrypt/decrypt path.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  storeFile,
  readFile,
  listFiles,
  search,
  createFolder,
  removeFile,
  type CollabSession,
  type ToolResult,
} from "../src/fula/collab/tools.js";
import { enc1Encrypt } from "../src/fula/collab/crypto.js";
import { serializeManifest, type CollaborationGroup, type CollaborationFile } from "../src/fula/collab/manifest.js";

const GROUP_ID = "1b9d7c2e-0000-4000-8000-000000000abc";
const WEBUI = "https://cloud.fx.land";
const LINK_SECRET = new Uint8Array(32);
for (let i = 0; i < 32; i++) LINK_SECRET[i] = (i * 5 + 1) & 0xff;
const MCP_PUB = "bWNwLXB1YmtleS1iYXNlNjQtMzJieXRlcy1leGFjdGx5MDA=";

function emptyGroup(): CollaborationGroup {
  return {
    id: GROUP_ID,
    name: "Test Group",
    ownerPublicKey: "owner-pub",
    manifestBucket: "fula-metadata",
    manifestKey: `manifests/${GROUP_ID}.json`,
    createdAt: "2026-01-01T00:00:00.000Z",
    isRevoked: false,
    files: [],
    removedFileIds: [],
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A faithful in-memory stand-in for the pinning-webui collab routes. */
class FakeCollabServer {
  manifestEnc1: string | null = null;
  manifestVersion = 0;
  files = new Map<string, Uint8Array>();
  putCount = 0;
  /** When set, the first N manifest PUTs reply 409 (to drive the CAS retry). */
  conflictsToInject = 0;
  /** The token the refresh endpoint hands back (drives the auth-retry path). */
  refreshedToken = "collab-write-tok";
  refreshCount = 0;

  async seed(group: CollaborationGroup): Promise<void> {
    this.manifestEnc1 = await enc1Encrypt(new TextEncoder().encode(serializeManifest(group)), LINK_SECRET, GROUP_ID);
    this.manifestVersion = 1;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (path.endsWith("/manifest-sync") && method === "GET") {
      if (this.manifestEnc1 === null) return new Response("not found", { status: 404 });
      return json({ encryptedManifest: this.manifestEnc1, version: this.manifestVersion }, 200, {
        ETag: `"${this.manifestVersion}"`,
      });
    }
    if (path.endsWith("/manifest-sync") && method === "PUT") {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== "Bearer collab-write-tok") {
        return json({ error: "unauthorized" }, 401);
      }
      if (this.conflictsToInject > 0) {
        this.conflictsToInject -= 1;
        return json({ error: "conflict", currentVersion: this.manifestVersion }, 409, {
          ETag: `"${this.manifestVersion}"`,
        });
      }
      const ifMatch = headers.get("if-match");
      if (ifMatch !== null) {
        const want = Number(ifMatch.replace(/"/g, ""));
        if (want !== this.manifestVersion) {
          return json({ error: "conflict", currentVersion: this.manifestVersion }, 409, {
            ETag: `"${this.manifestVersion}"`,
          });
        }
      }
      const body = JSON.parse(await bodyText(init)) as { encryptedManifest?: string };
      this.manifestEnc1 = body.encryptedManifest ?? this.manifestEnc1;
      this.manifestVersion += 1;
      this.putCount += 1;
      return json({ ok: true, version: this.manifestVersion }, 200, { ETag: `"${this.manifestVersion}"` });
    }
    if (path.endsWith("/upload") && method === "POST") {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== "Bearer collab-write-tok") return json({ error: "unauthorized" }, 401);
      const fileId = headers.get("x-collab-file-id")!;
      const bytes = await bodyBytes(init);
      this.files.set(fileId, bytes);
      return json({ storageKey: `.fula/collab/${GROUP_ID}/files/${fileId}`, bucket: "fula-metadata", fileId, size: bytes.length });
    }
    const fileMatch = path.match(/\/file\/([^/]+)$/);
    if (fileMatch && method === "GET") {
      const blob = this.files.get(fileMatch[1]!);
      if (!blob) return new Response("not found", { status: 404 });
      return new Response(blob, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    // The connection refresh endpoint: returns the collab-write token under
    // `collabToken` (NOT `token`, which is the gateway JWT — see refresh.ts).
    if (path.endsWith("/refresh-connection") && method === "POST") {
      this.refreshCount += 1;
      return json({ token: "gateway-jwt-ignored", collabToken: this.refreshedToken });
    }
    return new Response("not found", { status: 404 });
  };
}

function json(obj: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const body = JSON.stringify(obj);
  return new Response(body, { status, headers: { "content-type": "application/json", "content-length": String(body.length), ...extra } });
}
async function bodyText(init?: RequestInit): Promise<string> {
  const b = init?.body;
  if (typeof b === "string") return b;
  if (b instanceof Uint8Array) return new TextDecoder().decode(b);
  return "";
}
async function bodyBytes(init?: RequestInit): Promise<Uint8Array> {
  const b = init?.body;
  if (b instanceof Uint8Array) return b;
  if (typeof b === "string") return new TextEncoder().encode(b);
  return new Uint8Array(0);
}

function makeSession(
  server: FakeCollabServer,
  opts: { writeToken?: string | undefined; refreshUrl?: string; refreshToken?: string } = {},
): CollabSession {
  let token: string | undefined = "writeToken" in opts ? opts.writeToken : "collab-write-tok";
  return {
    fetchImpl: server.fetch,
    webuiBase: WEBUI,
    groupId: GROUP_ID,
    manifestBucket: "fula-metadata",
    linkSecret: LINK_SECRET,
    mcpPublicB64: MCP_PUB,
    collabWriteToken: () => token,
    setCollabWriteToken: (t: string) => {
      token = t;
    },
    refreshUrl: opts.refreshUrl,
    refreshToken: opts.refreshToken,
  };
}

function payloadOf(r: ToolResult): any {
  return r.structuredContent ?? JSON.parse(r.content[0]!.text);
}

let server: FakeCollabServer;
let session: CollabSession;

beforeEach(async () => {
  server = new FakeCollabServer();
  await server.seed(emptyGroup());
  session = makeSession(server);
});

describe("storeFile → manifest append + blob upload, then readFile round-trips", () => {
  it("stores a collab file and reads it back byte-for-byte", async () => {
    const data = new TextEncoder().encode("quarterly numbers ☕");
    const res = await storeFile(session, { data, fileName: "report.txt", mime: "text/plain", subfolder: "/notes" });
    expect(res.isError).toBeFalsy();
    const p = payloadOf(res);
    expect(p.enc_type).toBe("collab");
    expect(p.path).toBe("/notes/report.txt");
    expect(p.group_id).toBe(GROUP_ID);
    // The blob landed on the server, and the manifest gained the entry.
    expect(server.files.has(p.file_id)).toBe(true);
    expect(server.putCount).toBe(1);

    const read = await readFile(session, { fileId: p.file_id });
    expect(read.isError).toBeFalsy();
    const rp = payloadOf(read);
    expect(rp.encoding).toBe("base64");
    expect(new TextDecoder().decode(b64ToBytes(rp.content))).toBe("quarterly numbers ☕");

    // Reading by logical path resolves the same file.
    const byPath = payloadOf(await readFile(session, { path: "/notes/report.txt" }));
    expect(byPath.file_id).toBe(p.file_id);
  });

  it("stamps the Worker pubkey as addedByPublicKey", async () => {
    const p = payloadOf(await storeFile(session, { data: new Uint8Array([1, 2, 3]), fileName: "x.bin" }));
    const listed = payloadOf(await listFiles(session, {}));
    const entry = (listed.files as Array<{ file_id: string; added_by_public_key: string }>).find((f) => f.file_id === p.file_id)!;
    expect(entry.added_by_public_key).toBe(MCP_PUB);
  });
});

describe("listFiles + search", () => {
  beforeEach(async () => {
    await storeFile(session, { data: enc("a"), fileName: "memo.txt", mime: "text/plain", subfolder: "/notes" });
    await storeFile(session, { data: enc("b"), fileName: "pic.jpg", mime: "image/jpeg", subfolder: "/notes" });
    await storeFile(session, { data: enc("c"), fileName: "root.txt", mime: "text/plain" });
  });

  it("excludes directories by default and filters by folder + category", async () => {
    const all = payloadOf(await listFiles(session, {}));
    expect(all.count).toBe(3);

    const inNotes = payloadOf(await listFiles(session, { folder: "/notes" }));
    expect((inNotes.files as Array<{ file_name: string }>).map((f) => f.file_name).sort()).toEqual(["memo.txt", "pic.jpg"]);

    const images = payloadOf(await listFiles(session, { category: "image" }));
    expect(images.count).toBe(1);
    expect(images.files[0].file_name).toBe("pic.jpg");
  });

  it("search matches filename + path, empty query returns nothing", async () => {
    const byName = payloadOf(await search(session, "MEMO"));
    expect(byName.count).toBe(1);
    const byPath = payloadOf(await search(session, "/notes"));
    expect((byPath.files as Array<{ file_name: string }>).map((f) => f.file_name).sort()).toEqual(["memo.txt", "pic.jpg"]);
    const empty = payloadOf(await search(session, "   "));
    expect(empty.count).toBe(0);
  });
});

describe("createFolder + removeFile (tombstone, never DELETE)", () => {
  it("creates a directory marker visible only with includeDirectories", async () => {
    const res = await createFolder(session, "/projects/alpha");
    expect(res.isError).toBeFalsy();
    expect(payloadOf(res).path).toBe("/projects/alpha");

    const withoutDirs = payloadOf(await listFiles(session, {}));
    expect(withoutDirs.count).toBe(0); // marker hidden by default
    const withDirs = payloadOf(await listFiles(session, { includeDirectories: true }));
    const dir = (withDirs.files as Array<{ path: string; is_directory: boolean }>).find((f) => f.path === "/projects/alpha");
    expect(dir?.is_directory).toBe(true);
  });

  it("removes a file by tombstone and keeps the encrypted blob on the server", async () => {
    const stored = payloadOf(await storeFile(session, { data: enc("bye"), fileName: "gone.txt" }));
    const fileId = stored.file_id as string;
    expect(server.files.has(fileId)).toBe(true);

    const rem = await removeFile(session, fileId);
    expect(rem.isError).toBeFalsy();
    expect(payloadOf(rem).removed_path).toBe("/gone.txt");

    // No longer listed…
    const listed = payloadOf(await listFiles(session, {}));
    expect((listed.files as Array<{ file_id: string }>).some((f) => f.file_id === fileId)).toBe(false);
    // …but the encrypted object was NOT deleted (tombstone-only).
    expect(server.files.has(fileId)).toBe(true);
    // …and reading the tombstoned id fails.
    expect((await readFile(session, { fileId })).isError).toBe(true);
  });
});

describe("merge-on-write compare-and-swap", () => {
  it("retries on a 409 version conflict and still commits", async () => {
    server.conflictsToInject = 2; // first two PUTs 409, third succeeds
    const res = await storeFile(session, { data: enc("x"), fileName: "cas.txt" });
    expect(res.isError).toBeFalsy();
    expect(server.putCount).toBe(1); // one successful PUT after the retries
  });
});

describe("write-token refresh-on-auth, retry-once", () => {
  it("a stale write token is refreshed (via collabToken) and the write retries + succeeds", async () => {
    // Session starts with a STALE token the server rejects (401); the refresh
    // endpoint returns the good token under `collabToken`; the write retries.
    const s = makeSession(server, {
      writeToken: "stale-token",
      refreshUrl: "https://api.fx.land/api/mcp/tokens/refresh-connection",
      refreshToken: "rt-secret",
    });
    const res = await storeFile(s, { data: enc("hi"), fileName: "r.txt" });
    expect(res.isError).toBeFalsy();
    expect(server.refreshCount).toBeGreaterThanOrEqual(1);
    // The session swapped in the refreshed token.
    expect(s.collabWriteToken()).toBe("collab-write-tok");
  });

  it("a write with no refresh configured surfaces the auth rejection unchanged", async () => {
    const s = makeSession(server, { writeToken: "stale-token" }); // no refreshUrl/refreshToken
    const res = await storeFile(s, { data: enc("hi"), fileName: "r.txt" });
    expect(res.isError).toBe(true);
    expect(server.refreshCount).toBe(0);
  });
});

describe("read-only + owner-file deferral", () => {
  it("a session with no write token rejects writes with a read-only message", async () => {
    const ro = makeSession(server, { writeToken: undefined });
    const res = await storeFile(ro, { data: enc("x"), fileName: "x.txt" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain("read-only");
  });

  it("reading an owner (encType:fula) file returns a clear deferral message", async () => {
    // Seed a manifest carrying a fula-encrypted owner entry.
    const g = emptyGroup();
    const fula: CollaborationFile = {
      id: "owner-file-0000-4000-8000-00000000feed",
      fileName: "owner.pdf",
      bucket: "fula-metadata",
      storageKey: "obfs-storage-key",
      addedByPublicKey: "owner-pub",
      addedAt: "2026-01-02T00:00:00.000Z",
      fileSize: 10,
      encType: "fula",
      shareTokenJson: "{}",
    };
    g.files.push(fula);
    await server.seed(g);

    const res = await readFile(session, { fileId: fula.id });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain("owner");
  });
});

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
