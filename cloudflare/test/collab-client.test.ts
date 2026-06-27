/**
 * Streaming OOM-cap guard for the collab HTTP client (GLM-5.2 HIGH finding).
 * ════════════════════════════════════════════════════════════════════════════
 * An over-cap response body must be aborted MID-STREAM — even when a malicious /
 * compromised server omits (or lies about) `Content-Length` — rather than fully
 * buffered into the isolate before the size check. These tests drive the exported
 * `readBodyCapped` directly with a caller-supplied small cap.
 */

import { describe, it, expect } from "vitest";
import { readBodyCapped, CollabError } from "../src/fula/collab/client.js";

function streamOf(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readBodyCapped — streaming OOM cap", () => {
  it("assembles a within-cap multi-chunk body in order", async () => {
    const out = await readBodyCapped(streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), 100, "t");
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects an over-cap body sent with NO Content-Length", async () => {
    // 24 bytes streamed in three 8-byte chunks, cap = 10.
    const resp = streamOf([new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)]);
    await expect(readBodyCapped(resp, 10, "t")).rejects.toBeInstanceOf(CollabError);
  });

  it("stops pulling once the cap is crossed (does not drain the whole body)", async () => {
    let delivered = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += 1;
        controller.enqueue(new Uint8Array(8));
        if (delivered >= 100) controller.close();
      },
    });
    await expect(readBodyCapped(new Response(stream), 10, "t")).rejects.toMatchObject({ kind: "tooLarge" });
    // With a buffer-then-check reader this would drain all 100 chunks first; the
    // streaming reader cancels after the cap is crossed (~2 chunks).
    expect(delivered).toBeLessThan(100);
  });

  it("fast-rejects an honest oversized Content-Length before reading", async () => {
    const resp = new Response("x".repeat(20), { headers: { "content-length": "20" } });
    await expect(readBodyCapped(resp, 10, "t")).rejects.toBeInstanceOf(CollabError);
  });

  it("returns empty bytes for a null body", async () => {
    const out = await readBodyCapped(new Response(null, { status: 204 }), 10, "t");
    expect(out.length).toBe(0);
  });
});
