/**
 * Gateway-JWT refresh + per-user cache (H3). All with an INJECTED fetch (no real
 * network). Proves: the refresh POST shape, caching, per-user isolation, refresh
 * coalescing, forced refresh on a 401, and that no secret leaks across users.
 */

import { describe, it, expect } from "vitest";
import { GatewayTokenCache, GatewayRefreshError } from "../src/fula/gateway.js";

const URL_A = "https://refresh.example/refresh";
const RT_A = "refresh-token-A";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GatewayTokenCache", () => {
  it("POSTs {refresh_token} and returns the {token}", async () => {
    let seen: { url: string; body: any } | null = null;
    const cache = new GatewayTokenCache({
      fetchImpl: async (input, init) => {
        seen = { url: String(input), body: JSON.parse(String(init?.body)) };
        return jsonResponse({ token: "gw-jwt-1" });
      },
    });
    const tok = await cache.getToken("user1".padEnd(64, "0"), URL_A, RT_A);
    expect(tok).toBe("gw-jwt-1");
    expect(seen!.url).toBe(URL_A);
    expect(seen!.body).toEqual({ refresh_token: RT_A });
  });

  it("accepts access_token as an alias for token", async () => {
    const cache = new GatewayTokenCache({
      fetchImpl: async () => jsonResponse({ access_token: "gw-jwt-alias" }),
    });
    expect(await cache.getToken("u".padEnd(64, "0"), URL_A, RT_A)).toBe("gw-jwt-alias");
  });

  it("caches the token (a second call within TTL does NOT re-fetch)", async () => {
    let calls = 0;
    const cache = new GatewayTokenCache({
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ token: `gw-${calls}` });
      },
    });
    const u = "cacheuser".padEnd(64, "0");
    expect(await cache.getToken(u, URL_A, RT_A)).toBe("gw-1");
    expect(await cache.getToken(u, URL_A, RT_A)).toBe("gw-1"); // cached
    expect(calls).toBe(1);
  });

  it("isolates tokens per user (one user never gets another's token)", async () => {
    const tokens: Record<string, string> = {
      [("alice".padEnd(64, "0"))]: "tok-alice",
      [("bob".padEnd(64, "0"))]: "tok-bob",
    };
    let nextFor = "";
    const cache = new GatewayTokenCache({
      fetchImpl: async () => jsonResponse({ token: tokens[nextFor] }),
    });
    const alice = "alice".padEnd(64, "0");
    const bob = "bob".padEnd(64, "0");
    nextFor = alice;
    expect(await cache.getToken(alice, URL_A, RT_A)).toBe("tok-alice");
    nextFor = bob;
    expect(await cache.getToken(bob, URL_A, RT_A)).toBe("tok-bob");
    // Re-reading alice still returns alice's cached token, not bob's.
    expect(await cache.getToken(alice, URL_A, RT_A)).toBe("tok-alice");
  });

  it("coalesces concurrent refreshes for the same user into ONE fetch", async () => {
    let calls = 0;
    const cache = new GatewayTokenCache({
      fetchImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse({ token: "gw-coalesced" });
      },
    });
    const u = "race".padEnd(64, "0");
    const [a, b, c] = await Promise.all([
      cache.getToken(u, URL_A, RT_A),
      cache.getToken(u, URL_A, RT_A),
      cache.getToken(u, URL_A, RT_A),
    ]);
    expect([a, b, c]).toEqual(["gw-coalesced", "gw-coalesced", "gw-coalesced"]);
    expect(calls).toBe(1); // a single in-flight refresh served all three
  });

  it("force=true (the 401 path) bypasses the cache and re-fetches", async () => {
    let calls = 0;
    const cache = new GatewayTokenCache({
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ token: `gw-${calls}` });
      },
    });
    const u = "forceuser".padEnd(64, "0");
    expect(await cache.getToken(u, URL_A, RT_A)).toBe("gw-1");
    expect(await cache.getToken(u, URL_A, RT_A, true)).toBe("gw-2"); // forced
    expect(calls).toBe(2);
  });

  it("fails closed on a non-2xx refresh (no token, coarse error)", async () => {
    const cache = new GatewayTokenCache({
      fetchImpl: async () => new Response("nope", { status: 403 }),
    });
    await expect(cache.getToken("e".padEnd(64, "0"), URL_A, RT_A)).rejects.toBeInstanceOf(
      GatewayRefreshError,
    );
  });

  it("fails closed when the response carries no token", async () => {
    const cache = new GatewayTokenCache({
      fetchImpl: async () => jsonResponse({ nothing: true }),
    });
    await expect(cache.getToken("e2".padEnd(64, "0"), URL_A, RT_A)).rejects.toBeInstanceOf(
      GatewayRefreshError,
    );
  });

  it("honours expires_in for the cache TTL (re-fetches after it lapses)", async () => {
    let now = 1_000_000;
    let calls = 0;
    const cache = new GatewayTokenCache({
      now: () => now,
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ token: `gw-${calls}`, expires_in: 30 }); // 30s
      },
    });
    const u = "ttluser".padEnd(64, "0");
    expect(await cache.getToken(u, URL_A, RT_A)).toBe("gw-1");
    now += 10_000; // +10s, still fresh (TTL 30s, skew 5s)
    expect(await cache.getToken(u, URL_A, RT_A)).toBe("gw-1");
    now += 25_000; // +35s total → past TTL → re-fetch
    expect(await cache.getToken(u, URL_A, RT_A)).toBe("gw-2");
    expect(calls).toBe(2);
  });
});
