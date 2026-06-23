/**
 * Unit tests for the H3b tag/search LOGIC that needs NO gateway: the
 * TagCloudMetadata byte-shape (FxFiles-format fidelity), tag write→list round-trip,
 * dedup semantics, and the search filter (name + optional tag). The live-gateway
 * leg (the actual encrypted read-modify-write against s3.cloud.fx.land) is deferred
 * to H4, exactly as H3 deferred the store→read round-trip.
 *
 * FORMAT FIDELITY is the load-bearing property: the serialized JSON byte-shape
 * MUST be identical to what FxFiles' Dart `TagCloudMetadata.toJson` /
 * `FileTag.toJson` / `TaggedFile.toJson` emit (lib/core/models/file_tag.dart), so
 * FxFiles can adopt the AI's tags. The golden assertions below pin the EXACT bytes
 * and are intentionally the SAME literals the local Rust `tags.rs` golden tests use
 * (which were themselves verified against the Dart toJson) — proving
 * TS bytes == Rust bytes == Dart bytes.
 */

import { describe, it, expect } from "vitest";
import {
  applyTagging,
  serializeTagDocument,
  fileKeysForTagName,
  searchFilter,
  parseTagDocumentForTest,
  emptyMetadataForTest,
  isNotFoundForTest,
  DEFAULT_TAG_COLOR,
  TAG_METADATA_KEY,
  type TagCloudMetadata,
} from "../src/fula/tools.js";
import { isInWorkspaceScope } from "../src/fula/classify.js";

// A stable timestamp so golden assertions are deterministic.
const T0 = "2026-06-20T00:00:00.000Z";

describe("TagCloudMetadata byte-shape == FxFiles Dart toJson (golden)", () => {
  it("empty document serializes exactly like Dart (key order, empty arrays)", () => {
    const doc = emptyMetadataForTest("u123", "2026-06-20T12:00:00.000Z");
    // userId, tags:[], taggedFiles:[], updatedAt, version — in Dart order.
    expect(serializeTagDocument(doc)).toBe(
      '{"userId":"u123","tags":[],"taggedFiles":[],"updatedAt":"2026-06-20T12:00:00.000Z","version":"1.0"}',
    );
  });

  it("a FileTag serializes exactly like Dart (colorValue is the decimal int)", () => {
    const doc = emptyMetadataForTest("u", T0);
    doc.tags.push({
      id: "tag-1",
      name: "Receipts",
      colorValue: DEFAULT_TAG_COLOR,
      createdAt: "2026-06-20T12:00:00.000Z",
      updatedAt: "2026-06-20T12:00:00.000Z",
      fileCount: 3,
    });
    const json = serializeTagDocument(doc);
    // colorValue is the DECIMAL of 0xFF1E88E5 (= 4280191205), as a Dart int in JSON.
    expect(json).toContain(
      '{"id":"tag-1","name":"Receipts","colorValue":4280191205,"createdAt":"2026-06-20T12:00:00.000Z","updatedAt":"2026-06-20T12:00:00.000Z","fileCount":3}',
    );
    // Guard the exact decimal so a refactor of the constant can't silently drift.
    expect(DEFAULT_TAG_COLOR).toBe(4280191205);
  });

  it("a TaggedFile emits localPath/iosAssetId as explicit null (NOT omitted)", () => {
    const doc = emptyMetadataForTest("u", T0);
    doc.taggedFiles.push({
      id: "assoc-1",
      tagId: "tag-1",
      localPath: null,
      remoteKey: "ai/image/abc-photo.png",
      iosAssetId: null,
      fileName: "abc-photo.png",
      taggedAt: "2026-06-20T12:00:00.000Z",
    });
    const json = serializeTagDocument(doc);
    // localPath + iosAssetId are PRESENT as null — byte-faithful to Dart jsonEncode.
    expect(json).toContain(
      '{"id":"assoc-1","tagId":"tag-1","localPath":null,"remoteKey":"ai/image/abc-photo.png","iosAssetId":null,"fileName":"abc-photo.png","taggedAt":"2026-06-20T12:00:00.000Z"}',
    );
  });

  it("the metadata key is the Rust-contract key, under the ai/ scope", () => {
    expect(TAG_METADATA_KEY).toBe("ai/tag-metadata/ai-workspace.json");
    // MUST be admitted by the ai/ scope gate (its first segment is `ai`); if someone
    // "fixes" it to `.fula/tags/...` this fails — that path is outside the ai/ grant.
    expect(isInWorkspaceScope(TAG_METADATA_KEY)).toBe(true);
  });
});

describe("parse tolerates a Dart-written document (missing fileCount/version)", () => {
  it("defaults fileCount→0 and version→1.0 exactly as Dart fromJson", () => {
    // A document the app could have written: a tag with NO fileCount, doc with NO
    // version. Dart's fromJson does `?? 0` / `?? '1.0'`; ours must match.
    const dart = {
      userId: "abcdef0123456789",
      tags: [
        {
          id: "t1",
          name: "Work",
          colorValue: 4280191205,
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      taggedFiles: [
        {
          id: "a1",
          tagId: "t1",
          localPath: null,
          remoteKey: "ai/document/x.pdf",
          iosAssetId: null,
          fileName: "x.pdf",
          taggedAt: T0,
        },
      ],
      updatedAt: T0,
    };
    const doc = parseTagDocumentForTest(dart);
    expect(doc.version).toBe("1.0");
    expect(doc.tags[0]!.fileCount).toBe(0);
    expect(doc.tags[0]!.name).toBe("Work");
    expect(doc.taggedFiles[0]!.remoteKey).toBe("ai/document/x.pdf");
  });

  it("round-trips losslessly through serialize → parse", () => {
    const doc = emptyMetadataForTest("u1", T0);
    applyTagging(doc, "ai/image/k-photo.png", "k-photo.png", ["Travel", "2026"], T0);
    const back = parseTagDocumentForTest(JSON.parse(serializeTagDocument(doc)));
    expect(back).toEqual(doc);
  });

  it("throws on a structurally-corrupt document (refuses to clobber)", () => {
    expect(() => parseTagDocumentForTest("not an object")).toThrow();
    // A tag missing its required id is corrupt.
    expect(() => parseTagDocumentForTest({ tags: [{ name: "x" }] })).toThrow();
  });
});

describe("isNotFound — the first-ever-tag_file linchpin (PINS our assumed error shape)", () => {
  // This gates the most important runtime path: with NO existing tag document, the
  // load must take the not-found branch and start fresh (rather than surface an
  // error). NOTE this pins our ASSUMED fula-client error shape against regression;
  // the REAL gateway not-found is exercised in H4, not here.
  it("treats the fula-client not-found shapes as not-found", () => {
    // Structured JSON message with a 404 status.
    expect(isNotFoundForTest(new Error(JSON.stringify({ data: { status: 404 } })))).toBe(true);
    // Structured code.
    expect(isNotFoundForTest(new Error(JSON.stringify({ code: "NOT_FOUND" })))).toBe(true);
    // Structured human message containing "not found".
    expect(
      isNotFoundForTest(new Error(JSON.stringify({ message: "object Not Found" }))),
    ).toBe(true);
    // Bare (non-JSON) message substrings.
    expect(isNotFoundForTest(new Error("the requested key was not found"))).toBe(true);
    expect(isNotFoundForTest(new Error("S3 error: NoSuchKey"))).toBe(true);
    expect(isNotFoundForTest(new Error("HTTP 404"))).toBe(true);
  });

  it("does NOT treat other errors as not-found (so they propagate)", () => {
    // A 401 must NOT be swallowed as not-found (it drives the retry, not a fresh doc).
    expect(isNotFoundForTest(new Error(JSON.stringify({ data: { status: 401 } })))).toBe(false);
    expect(isNotFoundForTest(new Error("connection reset by peer"))).toBe(false);
    expect(isNotFoundForTest("not even an Error" as unknown)).toBe(false);
  });
});

describe("read-modify-write — BOTH the fresh and existing-document branches", () => {
  // Exercises the two load() outcomes the gateway leg (H4) will produce, purely:
  //   • not-found → start from an empty doc (the first-ever tag_file).
  //   • existing  → merge into the prior doc (the second+ tag_file).
  // (The actual encrypted get/put round-trip is H4; here we drive the in-memory
  // read-modify the tool performs after load.)
  it("fresh branch: an empty doc + first tagging yields the new tags", () => {
    const fresh = emptyMetadataForTest("ai-workspace", T0); // what load()→null produces
    const { createdTags, addedAssociations } = applyTagging(
      fresh,
      "ai/note/first.txt",
      "first.txt",
      ["Inbox"],
      T0,
    );
    expect(createdTags).toEqual(["Inbox"]);
    expect(addedAssociations).toBe(1);
    expect(fresh.tags.length).toBe(1);
  });

  it("existing branch: re-loading the persisted doc and tagging again merges", () => {
    // Simulate call #1, persist, then call #2 loads the SAME bytes back.
    const first = emptyMetadataForTest("u", T0);
    applyTagging(first, "ai/note/a.txt", "a.txt", ["Work"], T0);
    const persisted = serializeTagDocument(first);

    const reloaded = parseTagDocumentForTest(JSON.parse(persisted)); // load()→existing
    const { createdTags, addedAssociations } = applyTagging(
      reloaded,
      "ai/note/b.txt",
      "b.txt",
      ["Work", "Urgent"], // Work already exists; Urgent is new
      T0,
    );
    expect(createdTags).toEqual(["Urgent"]); // Work is reused, not recreated
    expect(addedAssociations).toBe(2); // Work↔b and Urgent↔b
    expect(reloaded.tags.map((t) => t.name).sort()).toEqual(["Urgent", "Work"]);
    expect(reloaded.tags.find((t) => t.name === "Work")!.fileCount).toBe(2);
  });
});

describe("applyTagging — the read-modify crux (mirrors Rust apply_tagging)", () => {
  it("creates tags + associations, sets fileCount, null local/ios", () => {
    const doc = emptyMetadataForTest("u", T0);
    const { createdTags, addedAssociations } = applyTagging(
      doc,
      "ai/image/k-photo.png",
      "k-photo.png",
      ["Travel", "Beach"],
      T0,
    );
    expect(createdTags).toEqual(["Travel", "Beach"]);
    expect(addedAssociations).toBe(2);
    expect(doc.tags.length).toBe(2);
    expect(doc.taggedFiles.length).toBe(2);
    for (const t of doc.tags) {
      expect(t.fileCount).toBe(1);
      expect(t.colorValue).toBe(DEFAULT_TAG_COLOR);
    }
    for (const tf of doc.taggedFiles) {
      expect(tf.remoteKey).toBe("ai/image/k-photo.png");
      expect(tf.localPath).toBeNull();
      expect(tf.iosAssetId).toBeNull();
      expect(tf.fileName).toBe("k-photo.png");
    }
    // Every id is a hyphenated uuid v4 (matches the app, not the simple() form).
    for (const t of doc.tags) expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("dedupes a tag by name case-insensitively across files", () => {
    const doc = emptyMetadataForTest("u", T0);
    applyTagging(doc, "ai/file/a", "a", ["Work"], T0);
    const { createdTags, addedAssociations } = applyTagging(doc, "ai/file/b", "b", ["WORK"], T0);
    expect(createdTags).toEqual([]); // same-name tag is NOT recreated
    expect(addedAssociations).toBe(1); // but the new file gets a new association
    expect(doc.tags.length).toBe(1);
    expect(doc.tags[0]!.fileCount).toBe(2);
    expect(doc.taggedFiles.length).toBe(2);
  });

  it("is idempotent for the same (file, tag) pair", () => {
    const doc = emptyMetadataForTest("u", T0);
    applyTagging(doc, "ai/file/a", "a", ["Keep"], T0);
    const { createdTags, addedAssociations } = applyTagging(doc, "ai/file/a", "a", ["Keep"], T0);
    expect(createdTags).toEqual([]);
    expect(addedAssociations).toBe(0);
    expect(doc.tags.length).toBe(1);
    expect(doc.taggedFiles.length).toBe(1);
    expect(doc.tags[0]!.fileCount).toBe(1);
  });

  it("skips empty/whitespace names and trims display casing", () => {
    const doc = emptyMetadataForTest("u", T0);
    const { createdTags } = applyTagging(doc, "ai/file/a", "a", ["", "   ", "  Spaced Name  "], T0);
    expect(createdTags).toEqual(["Spaced Name"]); // trimmed, casing kept
    expect(doc.tags.length).toBe(1);
    expect(doc.tags[0]!.name).toBe("Spaced Name");
  });
});

describe("tag write → list round-trip (the H3b acceptance path)", () => {
  it("tags applied to a doc are exactly the tags list() would return", () => {
    // Simulate the read-modify-write that fula_tag_file does, then the read
    // fula_list_tags does — purely (no gateway). The list is doc.tags.
    const doc = emptyMetadataForTest("u", T0);
    applyTagging(doc, "ai/image/p1.png", "p1.png", ["Vacation", "Family"], T0);
    applyTagging(doc, "ai/image/p2.png", "p2.png", ["Vacation"], T0);
    // Persist (serialize) then re-load (parse) — what list_tags sees after a write.
    const reloaded = parseTagDocumentForTest(JSON.parse(serializeTagDocument(doc)));
    const names = reloaded.tags.map((t) => t.name).sort();
    expect(names).toEqual(["Family", "Vacation"]);
    const vacation = reloaded.tags.find((t) => t.name === "Vacation")!;
    expect(vacation.fileCount).toBe(2); // two files carry it
    expect(reloaded.tags.find((t) => t.name === "Family")!.fileCount).toBe(1);
  });
});

describe("searchFilter — name substring (Rust list.rs::search) + optional tag", () => {
  const entries = [
    { key: "ai/image/u1-beach-photo.png" },
    { key: "ai/document/u2-report.pdf" },
    { key: "ai/note/u3-image-of-the-day.txt" }, // filename contains "image"
  ];

  it("matches the FILENAME substring, case-insensitively", () => {
    expect(searchFilter(entries, "REPORT").map((e) => e.key)).toEqual([
      "ai/document/u2-report.pdf",
    ]);
  });

  it("an empty query matches every entry (Rust contract)", () => {
    expect(searchFilter(entries, "").length).toBe(3);
  });

  it("matches on the filename, NOT the category segment", () => {
    // Searching "image": must NOT return every ai/image/* file — only files whose
    // FILENAME contains "image" (here the note). The beach photo is under
    // ai/image/ but its filename has no "image".
    const out = searchFilter(entries, "image").map((e) => e.key);
    expect(out).toEqual(["ai/note/u3-image-of-the-day.txt"]);
  });

  it("AND-combines with a tag filter when tagKeys is provided", () => {
    // tagKeys = the files carrying the chosen tag. Only entries in BOTH the name
    // match AND the tag set survive.
    const tagKeys = new Set(["ai/image/u1-beach-photo.png", "ai/document/u2-report.pdf"]);
    // query "" (all) ∩ tag = the two tagged files.
    expect(searchFilter(entries, "", tagKeys).map((e) => e.key).sort()).toEqual([
      "ai/document/u2-report.pdf",
      "ai/image/u1-beach-photo.png",
    ]);
    // query "beach" ∩ tag = just the beach photo.
    expect(searchFilter(entries, "beach", tagKeys).map((e) => e.key)).toEqual([
      "ai/image/u1-beach-photo.png",
    ]);
    // A tag set that excludes everything → empty (a filter with no matches).
    expect(searchFilter(entries, "", new Set<string>()).length).toBe(0);
  });
});

describe("fileKeysForTagName — resolves a tag name to its file keys", () => {
  function docWithTags(): TagCloudMetadata {
    const d = emptyMetadataForTest("u", T0);
    applyTagging(d, "ai/image/a.png", "a.png", ["Trip", "Fun"], T0);
    applyTagging(d, "ai/image/b.png", "b.png", ["Trip"], T0);
    applyTagging(d, "ai/note/c.txt", "c.txt", ["Fun"], T0);
    return d;
  }

  it("returns the remoteKeys of files carrying the (case-insensitive) tag", () => {
    const doc = docWithTags();
    expect([...fileKeysForTagName(doc, "trip")].sort()).toEqual([
      "ai/image/a.png",
      "ai/image/b.png",
    ]);
    expect([...fileKeysForTagName(doc, "FUN")].sort()).toEqual([
      "ai/image/a.png",
      "ai/note/c.txt",
    ]);
  });

  it("returns an empty set for an unknown tag", () => {
    expect(fileKeysForTagName(docWithTags(), "nope").size).toBe(0);
  });
});

describe("scope confinement of search/tag keys (ai/ segment geometry)", () => {
  it("a tagged file's remoteKey and the search keys stay inside ai/", () => {
    const doc = emptyMetadataForTest("u", T0);
    applyTagging(doc, "ai/image/k.png", "k.png", ["X"], T0);
    // Every association key is in scope.
    for (const tf of doc.taggedFiles) {
      expect(isInWorkspaceScope(tf.remoteKey!)).toBe(true);
    }
    // The search filter operates only on already-confined entries; a hostile key
    // would be dropped by isInWorkspaceScope BEFORE searchFilter (proven here).
    const hostile = [{ key: "ai/image/ok.png" }, { key: "photos/evil.png" }];
    const confined = hostile.filter((e) => isInWorkspaceScope(e.key));
    expect(searchFilter(confined, "").map((e) => e.key)).toEqual(["ai/image/ok.png"]);
  });
});
