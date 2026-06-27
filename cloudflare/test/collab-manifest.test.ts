/**
 * Manifest model + CRDT merge + tree helpers — ports the discriminating cases
 * from the Rust `crates/fula-mcp/src/{manifest,store,tree}.rs` tests so the
 * Worker's merge behaviour matches byte-for-byte.
 */

import { describe, it, expect } from "vitest";
import {
  parseManifest,
  serializeManifest,
  mergeWith,
  type CollaborationGroup,
  type CollaborationFile,
} from "../src/fula/collab/manifest.js";
import {
  DIRECTORY_CONTENT_TYPE,
  isDirectory,
  normalizeFolder,
  logicalPathOf,
  pathUnderFolder,
  liveFiles,
} from "../src/fula/collab/tree.js";

function group(id: string, version: number, files: CollaborationFile[]): CollaborationGroup {
  return {
    id,
    name: `name-${id}`,
    ownerPublicKey: "owner",
    manifestBucket: "fula-metadata",
    manifestKey: "mk",
    createdAt: "2026-01-01T00:00:00.000Z",
    isRevoked: false,
    files,
    removedFileIds: [],
    version,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function file(
  id: string,
  name: string,
  addedAt = "2026-01-01T00:00:00.000Z",
  scope?: string,
  ct?: string,
): CollaborationFile {
  const f: CollaborationFile = {
    id,
    fileName: name,
    bucket: "b",
    storageKey: `sk-${id}`,
    addedByPublicKey: "pk",
    addedAt,
    fileSize: 1,
    encType: "collab",
  };
  if (scope !== undefined) f.pathScope = scope;
  if (ct !== undefined) f.contentType = ct;
  return f;
}

describe("manifest parse/serialize", () => {
  it("applies Dart defaults on read (manifestBucket, isRevoked, version, encType)", () => {
    const g = parseManifest(
      JSON.parse(
        '{"id":"g","name":"n","ownerPublicKey":"o","manifestKey":"k","createdAt":"c","updatedAt":"u","files":[{"id":"x","fileName":"f","bucket":"b","storageKey":"s","addedByPublicKey":"p","addedAt":"a","fileSize":3}]}',
      ),
    );
    expect(g.manifestBucket).toBe("fula-metadata");
    expect(g.isRevoked).toBe(false);
    expect(g.version).toBe(1);
    expect(g.files[0]!.encType).toBe("fula"); // default
    expect(g.removedFileIds).toEqual([]);
  });

  it("serialize → parse round-trips and omits empty optionals", () => {
    const g = group("g", 2, [file("F1", "a.txt")]);
    const json = serializeManifest(g);
    // Empty removedFileIds is omitted (matches Dart `if (removedFileIds.isNotEmpty)`).
    expect(json).not.toContain("removedFileIds");
    // Absent contentType/pathScope are omitted.
    expect(json).not.toContain("contentType");
    expect(json).not.toContain("pathScope");
    const back = parseManifest(JSON.parse(json));
    expect(back).toEqual(g);
  });

  it("serialize emits removedFileIds when present", () => {
    const g = group("g", 1, []);
    g.removedFileIds.push("Z");
    expect(serializeManifest(g)).toContain('"removedFileIds":["Z"]');
  });
});

describe("CRDT merge (mergeWith — receiver wins on existing id)", () => {
  it("keeps the AI add AND a concurrent human add; version = max+1", () => {
    const remote = group("g", 2, [file("A", "a.txt", "2026-01-02T00:00:00.000Z"), file("B", "b.txt", "2026-01-03T00:00:00.000Z")]);
    const local = group("g", 1, [file("A", "a.txt", "2026-01-02T00:00:00.000Z"), file("F", "f.txt", "2026-01-04T00:00:00.000Z")]);
    const merged = mergeWith(remote, local, "2026-02-02T00:00:00.000Z");
    const ids = new Set(merged.files.map((f) => f.id));
    expect(ids.has("A") && ids.has("B") && ids.has("F")).toBe(true);
    expect(merged.version).toBe(3);
  });

  it("a concurrent human RENAME of an existing file wins (remote is the receiver)", () => {
    const local = group("g", 1, [file("A", "old.txt", "2026-01-02T00:00:00.000Z"), file("F", "f.txt", "2026-01-04T00:00:00.000Z")]);
    const remote = group("g", 2, [file("A", "new.txt", "2026-01-05T00:00:00.000Z")]);
    const merged = mergeWith(remote, local, "2026-02-02T00:00:00.000Z");
    expect(merged.files.find((f) => f.id === "A")!.fileName).toBe("new.txt");
    expect(merged.files.some((f) => f.id === "F")).toBe(true);
  });

  it("a tombstone wins over a concurrent re-add", () => {
    const remote = group("g", 2, [file("Z", "z.txt", "2026-01-06T00:00:00.000Z")]);
    const local = group("g", 1, []);
    local.removedFileIds.push("Z");
    const merged = mergeWith(remote, local, "2026-02-02T00:00:00.000Z");
    expect(merged.files.some((f) => f.id === "Z")).toBe(false);
    expect(merged.removedFileIds).toContain("Z");
  });

  it("revocation is monotonic and expiry only shortens", () => {
    const a = { ...group("g", 5, []), isRevoked: true, expiresAt: "2026-12-31T00:00:00.000Z" };
    const b = { ...group("g", 1, []), expiresAt: "2026-06-01T00:00:00.000Z" };
    const merged = mergeWith(a, b, "now");
    expect(merged.isRevoked).toBe(true); // revoked on either side
    expect(merged.expiresAt).toBe("2026-06-01T00:00:00.000Z"); // earlier wins
  });

  it("a present expiry always wins over an absent one (absent = least restrictive)", () => {
    const a = group("g", 2, []); // no expiry
    const b = { ...group("g", 1, []), expiresAt: "2026-06-01T00:00:00.000Z" };
    expect(mergeWith(a, b, "now").expiresAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("files are sorted by addedAt", () => {
    const remote = group("g", 1, [file("B", "b", "2026-01-03T00:00:00.000Z"), file("A", "a", "2026-01-01T00:00:00.000Z")]);
    const merged = mergeWith(remote, group("g", 1, []), "now");
    expect(merged.files.map((f) => f.id)).toEqual(["A", "B"]);
  });
});

describe("tree helpers", () => {
  it("normalizeFolder canonicalizes and rejects traversal", () => {
    expect(normalizeFolder("")).toBeNull();
    expect(normalizeFolder("/")).toBeNull();
    expect(normalizeFolder("/notes")).toBe("/notes");
    expect(normalizeFolder("notes/")).toBe("/notes");
    expect(normalizeFolder("//a///b//")).toBe("/a/b");
    expect(() => normalizeFolder("/a/../b")).toThrow();
    expect(() => normalizeFolder("/a/./b")).toThrow();
  });

  it("logicalPathOf handles folder-style and full-path-style pathScope", () => {
    expect(logicalPathOf(file("1", "memo.txt", undefined, "/notes"))).toBe("/notes/memo.txt");
    expect(logicalPathOf(file("2", "contract.pdf", undefined, "/legal/contract.pdf"))).toBe("/legal/contract.pdf");
    expect(logicalPathOf(file("3", "a.txt"))).toBe("/a.txt");
    const dir = file("4", "alpha", undefined, "/projects/alpha", DIRECTORY_CONTENT_TYPE);
    expect(isDirectory(dir)).toBe(true);
    expect(logicalPathOf(dir)).toBe("/projects/alpha");
  });

  it("pathUnderFolder respects segment boundaries", () => {
    expect(pathUnderFolder("/notes/memo.txt", "/notes")).toBe(true);
    expect(pathUnderFolder("/notebook/x.txt", "/notes")).toBe(false);
    expect(pathUnderFolder("/notes", "/notes")).toBe(false); // the marker itself isn't "under"
    expect(pathUnderFolder("/anything", "/")).toBe(true);
  });

  it("liveFiles excludes tombstones", () => {
    const g = group("g", 1, [file("a", "a.txt"), file("b", "b.txt")]);
    g.removedFileIds.push("b");
    expect(liveFiles(g).map((f) => f.id)).toEqual(["a"]);
  });
});
