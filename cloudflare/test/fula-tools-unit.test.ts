/**
 * Unit tests for the H3 tool helpers that need NO gateway: content encode/decode
 * (binary-safety), classification, key construction, and scope confinement.
 * The full store→read round-trip against the real gateway is deferred to H4.
 */

import { describe, it, expect } from "vitest";
import {
  decodeContent,
  encodeContent,
  ContentError,
  MAX_CONTENT_BYTES,
} from "../src/fula/content.js";
import {
  classify,
  buildWorkspaceKey,
  sanitizeFilenameSegment,
  isInWorkspaceScope,
  freshUuidSimple,
  WORKSPACE_BUCKET,
} from "../src/fula/classify.js";

describe("content encode/decode — binary safety", () => {
  it("utf8 round-trips text exactly", () => {
    const bytes = decodeContent("hello, monde — café ☕", "utf8");
    expect(encodeContent(bytes, "utf8")).toBe("hello, monde — café ☕");
  });

  it("base64 round-trips ARBITRARY binary (incl. NUL + high bytes) exactly", () => {
    // The bytes that a naive utf8 path would corrupt: NUL, 0xFF, JPEG magic.
    const raw = new Uint8Array([0x00, 0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
    const b64 = encodeContent(raw, "base64");
    const back = decodeContent(b64, "base64");
    expect(Array.from(back)).toEqual(Array.from(raw));
  });

  it("rejects non-canonical base64 (whitespace / url-safe chars)", () => {
    expect(() => decodeContent("aGVs bG8=", "base64")).toThrow(ContentError); // space
    expect(() => decodeContent("a-_b", "base64")).toThrow(ContentError); // url-safe
  });

  it("reading binary as utf8 throws (so the caller re-reads as base64)", () => {
    const rawNonUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(() => encodeContent(rawNonUtf8, "utf8")).toThrow();
  });

  it("enforces the size cap on DECODED bytes", () => {
    // A base64 string whose decoded size exceeds the cap is rejected up front.
    const tooBig = "A".repeat(Math.ceil(((MAX_CONTENT_BYTES + 1024) * 4) / 3));
    expect(() => decodeContent(tooBig, "base64")).toThrow(/limit/);
  });
});

describe("classification → category", () => {
  it("classifies by mime prefix", () => {
    expect(classify("image/png", "x", undefined)).toBe("image");
    expect(classify("video/mp4", undefined, undefined)).toBe("video");
    expect(classify("audio/mpeg", undefined, undefined)).toBe("audio");
    expect(classify("application/pdf", undefined, undefined)).toBe("document");
  });
  it("classifies by extension when mime is absent", () => {
    expect(classify(undefined, "photo.JPG", undefined)).toBe("image");
    expect(classify(undefined, "clip.mov", undefined)).toBe("video");
    expect(classify(undefined, "notes.md", undefined)).toBe("note");
    expect(classify(undefined, "report.pdf", undefined)).toBe("document");
  });
  it("treats a pure text payload as a note", () => {
    expect(classify(undefined, undefined, "just some thoughts")).toBe("note");
  });
  it("defaults to other", () => {
    expect(classify(undefined, "blob.xyz", undefined)).toBe("other");
    expect(classify(undefined, undefined, undefined)).toBe("other");
  });
});

describe("workspace key construction (mirrors Rust store.rs)", () => {
  it("builds ai/<category>/<uuid>-<safe-name>", () => {
    const key = buildWorkspaceKey("image", "photo.jpg", "0".repeat(32));
    expect(key).toBe("ai/image/00000000000000000000000000000000-photo.jpg");
  });
  it("falls back to uuid-only when the filename is unusable", () => {
    for (const bad of ["", "/", "///", "../..", "."]) {
      const key = buildWorkspaceKey("other", bad, "0".repeat(32));
      expect(key).toBe("ai/other/00000000000000000000000000000000");
    }
  });
  it("sanitizes a name to basename + ASCII allowlist", () => {
    expect(sanitizeFilenameSegment("a/b/c.txt")).toBe("c.txt");
    expect(sanitizeFilenameSegment("..\\..\\etc\\passwd")).toBe("passwd");
    expect(sanitizeFilenameSegment("My File (1).PNG")).toBe("My_File__1_.PNG");
    expect(sanitizeFilenameSegment("../..")).toBeNull();
  });
  it("freshUuidSimple yields 32 hex chars (no hyphens)", () => {
    const u = freshUuidSimple();
    expect(u).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("scope confinement (segment geometry, not substring)", () => {
  it("accepts canonical ai/ keys", () => {
    expect(isInWorkspaceScope("ai/image/abc-photo.jpg")).toBe(true);
    expect(isInWorkspaceScope("ai/tag-metadata/ai-workspace.json")).toBe(true);
  });
  it("rejects non-ai first segment incl. the substring footgun", () => {
    expect(isInWorkspaceScope("ai-evil/x")).toBe(false); // not a SUBSTRING match
    expect(isInWorkspaceScope("photos/2026/x.jpg")).toBe(false);
    expect(isInWorkspaceScope("x")).toBe(false);
  });
  it("rejects traversal / empty / NUL segments", () => {
    expect(isInWorkspaceScope("ai/../secrets")).toBe(false);
    expect(isInWorkspaceScope("ai//double")).toBe(false);
    expect(isInWorkspaceScope("ai/x\0y")).toBe(false);
  });
  it("the bucket constant matches the Rust contract", () => {
    expect(WORKSPACE_BUCKET).toBe("fula-ai-workspace");
  });
});
