/**
 * Collab write-token refresh-on-auth, retry-once (GLM-5.2 LOW correctness finding).
 * ════════════════════════════════════════════════════════════════════════════
 * The retry that runs AFTER a successful refresh must surface a NON-auth failure
 * (e.g. a 409 version conflict) unchanged, so the caller's compare-and-swap loop
 * in `commitManifestChange` can act on it. Masking it as the original auth error
 * would silently defeat the CAS retry. A repeated AUTH failure still falls back to
 * the original auth error (never loop, never leak refresh detail).
 */

import { describe, it, expect } from "vitest";
import { withCollabWriteRetry, type WriteTokenContext } from "../src/fula/collab/refresh.js";
import { CollabError } from "../src/fula/collab/client.js";

/** A context whose refresh endpoint returns a fresh `collabToken`. */
function ctxWithRefresh(onSwap: (t: string) => void): WriteTokenContext {
  let token = "stale";
  return {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ token: "gateway-jwt-ignored", collabToken: "fresh" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    collabWriteToken: () => token,
    setCollabWriteToken: (t: string) => {
      token = t;
      onSwap(t);
    },
    refreshUrl: "https://api.example/refresh",
    refreshToken: "rt-secret",
  };
}

describe("withCollabWriteRetry — refresh-on-auth, retry-once", () => {
  it("surfaces a non-auth retry error (409) so the CAS loop can act (not masked as auth)", async () => {
    let calls = 0;
    let swapped: string | undefined;
    const ctx = ctxWithRefresh((t) => (swapped = t));
    const op = async (_token: string): Promise<never> => {
      calls += 1;
      if (calls === 1) throw new CollabError("auth", "stale token", 401);
      throw new CollabError("conflict", "version moved", 409);
    };
    await expect(withCollabWriteRetry(ctx, op)).rejects.toMatchObject({ kind: "conflict" });
    expect(calls).toBe(2); // initial auth-fail + exactly one post-refresh retry
    expect(swapped).toBe("fresh"); // refreshed token swapped in before the retry
  });

  it("falls back to the original auth error when the retry ALSO fails auth (no loop)", async () => {
    let calls = 0;
    const ctx = ctxWithRefresh(() => {});
    const op = async (_token: string): Promise<never> => {
      calls += 1;
      throw new CollabError("auth", calls === 1 ? "stale" : "still-bad", 401);
    };
    await expect(withCollabWriteRetry(ctx, op)).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(2);
  });

  it("returns the op result on success without refreshing", async () => {
    let refreshed = false;
    const ctx = ctxWithRefresh(() => (refreshed = true));
    const out = await withCollabWriteRetry(ctx, async () => "ok");
    expect(out).toBe("ok");
    expect(refreshed).toBe(false);
  });
});
