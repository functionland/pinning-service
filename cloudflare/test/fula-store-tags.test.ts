/**
 * Round-trip test for `fula_store_file`'s tag-writing (the H3-tags fix): storing a
 * file WITH tags must associate it in the AI's tag document so it is findable by
 * `fula_list_tags` and `fula_search(tag:…)` — the tags are written, not merely
 * echoed in the response. Storing WITHOUT tags must leave the tag document
 * untouched (byte-for-byte the prior behavior).
 *
 * Unlike the H3/H3b unit tests (pure helpers) and the dispatch tests (fail-closed,
 * no capability), this drives the REAL `storeFile` / `listTags` / `search`
 * orchestration through `withWorkspaceClient`, mocking exactly the seams the tool
 * bodies cross: the WASM storage layer (`./wasm.js`, an in-memory key→bytes Map),
 * the custody capability (`../capability.js`), and the gateway-token cache
 * (`./gateway.js`). The crypto/gateway round-trip itself is out of scope (its own
 * deferred H4 leg); here the property under test is the tag-doc read-modify-write
 * that store now performs in the SAME session as the upload.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── The shared in-memory object store the mocked WASM client reads/writes ──────
// vi.hoisted so the mock factories (which are hoisted above the imports) can close
// over the SAME Map instance the tests inspect/reset.
const store = vi.hoisted(() => {
  return {
    objects: new Map<string, { bytes: Uint8Array; contentType: string }>(),
    putCount: 0,
  };
});

// Mock the WASM storage layer: a sentinel client + in-memory put/get/list keyed
// by the LOGICAL key (so `listDecrypted` returns `originalKey === ` the key the
// tool put — the linchpin search() relies on to resolve a tag's files).
vi.mock("../src/fula/wasm.js", () => {
  const SENTINEL = { __mockClient: true } as const;
  return {
    createEncryptedClient: vi.fn(async () => SENTINEL),
    freeClient: vi.fn(() => {}),
    putEncryptedWithType: vi.fn(
      async (_client: unknown, _bucket: string, key: string, data: Uint8Array, contentType: string) => {
        store.putCount += 1;
        store.objects.set(key, { bytes: data.slice(), contentType });
        return { etag: `etag-${key}` };
      },
    ),
    getDecrypted: vi.fn(async (_client: unknown, _bucket: string, key: string) => {
      const o = store.objects.get(key);
      if (!o) {
        // The shape `isNotFound` recognizes (structured 404), so a missing tag doc
        // takes the "start fresh" branch exactly as the real client would.
        throw new Error(JSON.stringify({ data: { status: 404 }, message: "not found" }));
      }
      return o.bytes.slice();
    }),
    listDecrypted: vi.fn(async (_client: unknown, _bucket: string, options: { prefix?: string } = {}) => {
      const prefix = options.prefix ?? "";
      return [...store.objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({
          originalKey: k,
          storageKey: `obf-${k}`,
          size: store.objects.get(k)!.bytes.length,
          contentType: store.objects.get(k)!.contentType,
          modifiedAt: 0,
        }));
    }),
  };
});

// Mock the custody capability so `withWorkspaceClient` gets a usable cap WITHOUT
// OpenBao. `workspace_secret` MUST be valid base64 (`withWorkspaceClient` runs
// `atob` on it before building the — mocked — client).
vi.mock("../src/capability.js", () => {
  return {
    loadCapabilityForSession: vi.fn(async () => ({
      get: () => ({
        workspace_secret: btoa("0123456789abcdef0123456789abcdef"), // 32 bytes, valid b64
        endpoint: "https://gw.invalid",
        refresh_url: "https://gw.invalid/refresh",
        refresh_token: "test-refresh-token",
      }),
      dispose: () => {},
    })),
    recordAudit: vi.fn(async () => {}),
  };
});

// Mock the gateway token cache so no real `fetch`/TTL machinery runs.
vi.mock("../src/fula/gateway.js", () => {
  class GatewayRefreshError extends Error {}
  return {
    gatewayTokenCache: vi.fn(() => ({
      getToken: vi.fn(async () => "test-gateway-jwt"),
      invalidate: vi.fn(() => {}),
    })),
    GatewayRefreshError,
  };
});

// Import AFTER the mocks are registered.
import { storeFile, listTags, search, TAG_METADATA_KEY } from "../src/fula/tools.js";
import type { CapabilityEnv } from "../src/capability.js";

// A stand-in env; the mocked capability + audit ignore CUSTODY_DB, so any value works.
const env = { CUSTODY_DB: {} } as unknown as CapabilityEnv;
const USER = "user-abc";

function payloadOf(result: { structuredContent?: Record<string, unknown>; content: Array<{ text: string }> }): any {
  return result.structuredContent ?? JSON.parse(result.content[0]!.text);
}

beforeEach(() => {
  store.objects.clear();
  store.putCount = 0;
});

describe("fula_store_file writes tags to the tag doc (smoke: the seam works)", () => {
  it("storing with one tag lands BOTH the file object and the tag document", async () => {
    const res = await storeFile(env, USER, {
      content: "hello",
      encoding: "utf8",
      name: "note.txt",
      tags: ["Work"],
    });
    expect(res.isError).toBeFalsy();
    const payload = payloadOf(res);
    // The file key the tool minted (ai/note/<uuid>-note.txt) is an object.
    expect(typeof payload.key).toBe("string");
    expect(store.objects.has(payload.key)).toBe(true);
    // The tag document was written (the fix — previously tags were advisory only).
    expect(store.objects.has(TAG_METADATA_KEY)).toBe(true);
    // The response reports the tags it actually applied (not a bare echo).
    expect(payload.tags).toEqual(["Work"]);
    expect(payload.tag_warning).toBeUndefined();
  });
});

describe("round-trip: store(tags) → list_tags shows them → search(tag) finds the file", () => {
  it("a tag applied at store time is listed and resolves the file in search", async () => {
    const stored = await storeFile(env, USER, {
      content: "quarterly numbers",
      encoding: "utf8",
      name: "report.txt",
      tags: ["Work", "2026"],
    });
    const storeKey = payloadOf(stored).key as string;
    expect(payloadOf(stored).tags.sort()).toEqual(["2026", "Work"]);

    // list_tags surfaces the tags the store wrote.
    const tags = payloadOf(await listTags(env, USER));
    const tagNames = (tags.tags as Array<{ name: string; fileCount: number }>).map((t) => t.name).sort();
    expect(tagNames).toEqual(["2026", "Work"]);
    expect(
      (tags.tags as Array<{ name: string; fileCount: number }>).find((t) => t.name === "Work")!.fileCount,
    ).toBe(1);

    // search(tag) finds the stored file (query "" matches all names; tag AND-filters).
    const found = payloadOf(await search(env, USER, { query: "", tag: "Work" }));
    const foundKeys = (found.files as Array<{ key: string }>).map((f) => f.key);
    expect(foundKeys).toContain(storeKey);
    // The tag-metadata doc itself is in the listing but NOT in the tag's file set,
    // so it is correctly excluded from the result.
    expect(foundKeys).not.toContain(TAG_METADATA_KEY);

    // A tag nobody applied resolves to nothing.
    const none = payloadOf(await search(env, USER, { query: "", tag: "Nonexistent" }));
    expect((none.files as unknown[]).length).toBe(0);
  });

  it("a SECOND store with an overlapping tag merges into the same doc (no duplicate tag)", async () => {
    const a = await storeFile(env, USER, {
      content: "a",
      encoding: "utf8",
      name: "a.txt",
      tags: ["Shared"],
    });
    const b = await storeFile(env, USER, {
      content: "b",
      encoding: "utf8",
      name: "b.txt",
      tags: ["Shared"],
    });
    const keyA = payloadOf(a).key as string;
    const keyB = payloadOf(b).key as string;

    const tags = payloadOf(await listTags(env, USER));
    // "Shared" exists exactly once, with fileCount 2.
    const shared = (tags.tags as Array<{ name: string; fileCount: number }>).filter((t) => t.name === "Shared");
    expect(shared.length).toBe(1);
    expect(shared[0]!.fileCount).toBe(2);

    const found = payloadOf(await search(env, USER, { query: "", tag: "Shared" }));
    const foundKeys = (found.files as Array<{ key: string }>).map((f) => f.key).sort();
    expect(foundKeys).toEqual([keyA, keyB].sort());
  });
});

describe("store WITHOUT (usable) tags leaves the tag document untouched", () => {
  it("no tags → no tag document is read or written", async () => {
    const res = await storeFile(env, USER, {
      content: "untagged",
      encoding: "utf8",
      name: "plain.txt",
    });
    const payload = payloadOf(res);
    expect(res.isError).toBeFalsy();
    // The file object exists…
    expect(store.objects.has(payload.key)).toBe(true);
    // …but the tag document was NEVER written.
    expect(store.objects.has(TAG_METADATA_KEY)).toBe(false);
    // The response carries an empty tags array + no tag-doc affordances.
    expect(payload.tags).toEqual([]);
    expect(payload.metadata_key).toBeUndefined();
    expect(payload.tag_warning).toBeUndefined();
    // list_tags sees an empty workspace.
    const tags = payloadOf(await listTags(env, USER));
    expect((tags.tags as unknown[]).length).toBe(0);
  });

  it("an all-whitespace tags array behaves exactly like no tags", async () => {
    const res = await storeFile(env, USER, {
      content: "untagged",
      encoding: "utf8",
      name: "plain2.txt",
      tags: ["", "   "],
    });
    const payload = payloadOf(res);
    expect(res.isError).toBeFalsy();
    expect(store.objects.has(TAG_METADATA_KEY)).toBe(false);
    expect(payload.tags).toEqual([]);
    expect(payload.metadata_key).toBeUndefined();
  });
});

describe("best-effort: a tag-write failure does NOT fail the store", () => {
  it("file stays stored + a tag_warning is surfaced when the tag PUT fails", async () => {
    // Make ONLY the tag-document PUT fail; the file PUT still succeeds. The store
    // must report success (the file IS stored) with tags:[] and a warning.
    const wasm = await import("../src/fula/wasm.js");
    const putMock = wasm.putEncryptedWithType as unknown as ReturnType<typeof vi.fn>;
    putMock.mockImplementationOnce(
      async (_c: unknown, _b: string, key: string, data: Uint8Array, contentType: string) => {
        // first call = the file object → succeed
        store.putCount += 1;
        store.objects.set(key, { bytes: data.slice(), contentType });
        return { etag: `etag-${key}` };
      },
    );
    putMock.mockImplementationOnce(async () => {
      // second call = the tag document → fail
      throw new Error("simulated tag-doc write failure");
    });

    const res = await storeFile(env, USER, {
      content: "hi",
      encoding: "utf8",
      name: "f.txt",
      tags: ["Work"],
    });
    const payload = payloadOf(res);
    expect(res.isError).toBeFalsy(); // store did NOT fail
    expect(store.objects.has(payload.key)).toBe(true); // file is stored
    expect(store.objects.has(TAG_METADATA_KEY)).toBe(false); // tag doc did not land
    expect(payload.tags).toEqual([]); // nothing durably tagged
    expect(typeof payload.tag_warning).toBe("string");
    expect(payload.tag_warning).toMatch(/file stored/i);
  });
});
