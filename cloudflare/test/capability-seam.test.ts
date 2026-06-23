/**
 * H2-store ⇄ H3-load capability KEYING SEAM — the cross-agent proof.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * THE SEAM (built by different agents; this test is the gate)
 * ──────────────────────────────────────────────────────────
 * The `user_id` a capability is STORED under (H2: `capability.ts handleCapability`,
 * the `POST /capability` FxFiles→Worker delegation) MUST be byte-identical to the
 * `user_id` it is LOADED by (H3: `mcp.ts resolveUserIdFromProps` → the MCP tools →
 * `capability.ts loadCapabilityForSession`). If they differ, an AI OAuth-connects
 * successfully but EVERY tool call fails "no capability found" — a silent seam.
 *
 *   STORE keying (capability.ts:111-126,144):
 *       userId = emailToUserId(props.email)   (cross-checked == token `sub`)
 *       → sealCapability(db, bao, userId, cap)
 *   LOAD keying (mcp.ts resolveUserIdFromProps; used by every tool via withUser):
 *       props.userId (when a 64-char hex) ELSE emailToUserId(props.email)
 *       → loadCapabilityForSession(env, userId) → openCapability(db, bao, userId)
 *
 * Both sides read the SAME decrypted OAuth grant `props`, which `google.ts` sets
 * ONCE at federation as `{ email: email.toLowerCase(), userId: emailToUserId(email) }`.
 * So `props.userId === emailToUserId(props.email)` by construction and the two
 * keyings CONVERGE. This test proves that empirically end-to-end, exercising the
 * REAL store path and the REAL load path (no replicated keying logic).
 *
 * WHY THIS IS A TRUE DISCRIMINATOR (not a tautology): the store side derives the
 * key FROM THE EMAIL; the load side reads `props.userId`. We build `props` exactly
 * as production does (so `props.userId` is present). If a future change made the
 * load side key off a different field — or the store off the `sub` while load off
 * the email — the round-trip below would return `null` (no row at the load key)
 * and step 3 would FAIL LOUDLY. That is the seam breaking.
 *
 * ── OpenBao: a deterministic MOCK, so this gate ALWAYS RUNS ───────────────────
 * `custody.test.ts` exercises the GENUINE OpenBao transit wrap/unwrap (gated on a
 * live local server via `describeLive`). This file is the SEAM test, and the seam
 * dimension — the `user_id` flowing through the D1 primary key, the AEAD AAD
 * (`buildAad` length-prefixes `user_id`), and the embedded-user_id recheck — is
 * FULLY REAL under a mocked DEK-wrap: OpenBao only wraps/unwraps the per-record
 * DEK; it never sees `user_id`. So we mock ONLY `openBaoFromEnv` (which BOTH
 * `handleCapability` and `loadCapabilityForSession` call) with an in-memory transit
 * that round-trips the DEK deterministically. This keeps the gate ALWAYS-ON (it
 * must never silently skip — it is THE gate before the hosted server is declared
 * ready), independent of whether a live OpenBao is present. The mock is file-
 * scoped (`vi.mock` hoists per-module), so custody.test.ts's live path is untouched.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";

// ── Mock ONLY the OpenBao transit factory — file-scoped, deterministic ────────
// A faithful-enough transit stub: wrapDek emits an opaque "vault:mock:<b64(dek)>"
// and unwrapDek reverses it. It NEVER touches user_id; the seam is fully real.
vi.mock("../src/openbao.js", () => {
  function b64encode(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function b64decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const mockBao = {
    async wrapDek(dek: Uint8Array): Promise<string> {
      return `vault:mock:${b64encode(dek)}`;
    },
    async unwrapDek(wrapped: string): Promise<Uint8Array> {
      if (typeof wrapped !== "string" || !wrapped.startsWith("vault:mock:")) {
        throw new Error("mock unwrap: not a mock-wrapped DEK");
      }
      const dek = b64decode(wrapped.slice("vault:mock:".length));
      if (dek.length !== 32) throw new Error("mock unwrap: bad DEK length");
      return dek;
    },
  };
  return {
    // Both handleCapability (store) and loadCapabilityForSession (load) build
    // their transit via this single factory — mocking it covers BOTH paths.
    openBaoFromEnv: () => mockBao,
    // Re-exported only so the module's named-export surface stays intact for any
    // other importer; the seam test exercises openBaoFromEnv exclusively.
    OpenBaoTransit: class {},
    OpenBaoError: class extends Error {},
  };
});

import { handleCapability, loadCapabilityForSession, type CapabilityEnv } from "../src/capability.js";
import { emailToUserId } from "../src/userId.js";
import { resolveUserIdFromProps, type FulaAuthProps } from "../src/mcp.js";
import type { CapabilityData, D1Like } from "../src/custody.js";

// The same human on BOTH sides of the seam.
const EMAIL = "seam-test@example.com";

// A representative capability (every field but `endpoint` is a secret). We
// round-trip a KNOWN field (refresh_token) at the end to prove decrypt fidelity.
const CAP: CapabilityData = {
  workspace_secret: "c2VhbS13b3Jrc3BhY2Utc2VjcmV0LTMyYi1leGFtcGxlLXZhbHVlMDE=",
  mcp_secret: "c2VhbS1tY3AteDI1NTE5LWNvbm5lY3Rpb24tc2VjcmV0LWV4YW1wbGU=",
  refresh_token: "rt_seam_known_field_to_round_trip_0xDEADBEEF_0001",
  refresh_url: "https://api.fx.land/api/mcp/tokens/refresh-connection",
  endpoint: "https://s3.cloud.fx.land",
};

function db(): D1Like {
  return env.CUSTODY_DB as unknown as D1Like;
}

/**
 * Build the env handed to BOTH store and load. For the STORE call we inject a
 * fake `unwrapToken` (exactly H2's delegation happy-path pattern in
 * custody.test.ts) returning the chosen Worker-OAuth token summary; the real
 * CUSTODY_DB is used throughout, and OpenBao is the file-scoped mock above.
 */
function envWith(summary: unknown): CapabilityEnv {
  return {
    ...(env as unknown as CapabilityEnv),
    OAUTH_PROVIDER: {
      unwrapToken: async () => summary,
    } as unknown as CapabilityEnv["OAUTH_PROVIDER"],
  };
}

/** The plain env (no OAuth fake needed) for the LOAD call. */
function plainEnv(): CapabilityEnv {
  return env as unknown as CapabilityEnv;
}

/** A `POST /capability` request carrying the capability JSON. */
function capabilityRequest(): Request {
  return new Request("http://localhost/capability", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer seam-token" },
    body: JSON.stringify(CAP),
  });
}

beforeAll(async () => {
  // Apply the custody schema to the (miniflare-simulated) local D1 — same inline
  // DDL custody.test.ts uses, so this file is self-contained.
  const d1 = env.CUSTODY_DB as unknown as { exec(q: string): Promise<unknown> };
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_capabilities (user_id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, capability_ciphertext BLOB NOT NULL, wrapped_dek TEXT NOT NULL, dek_version INTEGER NOT NULL DEFAULT 1, alg TEXT NOT NULL, endpoint TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)",
  );
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL, ts INTEGER NOT NULL, detail TEXT)",
  );
});

describe("H2-store ⇄ H3-load capability keying seam (always-on; mock OpenBao)", () => {
  it("STORE via /capability then LOAD via loadCapabilityForSession round-trips for the same human", async () => {
    // ── 0. Build the grant `props` EXACTLY as google.ts does at federation ─────
    // email lowercased; userId precomputed from it. This is the single object the
    // OAuth provider would hand BOTH the /capability token-unwrap and the /mcp
    // session. Building it faithfully is what makes the seam check meaningful:
    // STORE will derive from props.email; LOAD will read props.userId.
    const lowered = EMAIL.toLowerCase();
    const props: FulaAuthProps = {
      email: lowered,
      name: "Seam Tester",
      userId: await emailToUserId(lowered),
    };

    // ── 1. STORE — drive the REAL `/capability` delegation handler ─────────────
    // The fake token summary mirrors what `unwrapToken` returns for a valid
    // Worker-OAuth access token: subject = props.userId, scope mcp, props echoed.
    const summary = {
      userId: props.userId,
      scope: ["mcp"],
      grant: { clientId: "fxfiles", props },
    };
    const res = await handleCapability(capabilityRequest(), envWith(summary));
    expect(res.status).toBe(204); // sealed + custodied, no content

    // ── 2. LOAD — derive the user_id the REAL H3 way, then load+decrypt ─────────
    // resolveUserIdFromProps is the ACTUAL function the MCP tools use (via
    // resolveUserId/withUser); we call it directly so the load-side KEYING is
    // exercised for real (no replicated logic). loadCapabilityForSession is the
    // real H3 entry point the tools call.
    const loadUserId = await resolveUserIdFromProps(props);
    expect(loadUserId).not.toBeNull();

    // ── 3a. THE SEAM ASSERTION — store key == load key, byte for byte ──────────
    // The store side keyed the row under emailToUserId(props.email). The load side
    // resolved loadUserId independently. They MUST be the same 64-char hex.
    const storeUserId = await emailToUserId(props.email);
    expect(loadUserId).toBe(storeUserId);
    expect(loadUserId).toMatch(/^[0-9a-f]{64}$/);

    // ── 3b. THE PROOF — the load actually finds + decrypts what the store sealed ─
    const cap = await loadCapabilityForSession(plainEnv(), loadUserId!);
    expect(cap).not.toBeNull(); // null here = the seam is BROKEN (wrong key → no row)
    try {
      // Round-trip a KNOWN field end to end (store → seal → load → decrypt).
      expect(cap!.get().refresh_token).toBe(CAP.refresh_token);
      expect(cap!.get()).toEqual(CAP);
    } finally {
      cap!.dispose();
    }
  });

  it("a DIFFERENT human's session loads NOTHING (the key truly partitions custody)", async () => {
    // Negative control: prove the round-trip above succeeded because the KEYS
    // matched, not because load is indiscriminate. A different email derives a
    // different user_id, for which no row was sealed → load returns null.
    const otherProps: FulaAuthProps = {
      email: "someone-else@example.com",
      userId: await emailToUserId("someone-else@example.com"),
    };
    const otherUserId = await resolveUserIdFromProps(otherProps);
    expect(otherUserId).not.toBe(await emailToUserId(EMAIL.toLowerCase()));
    const cap = await loadCapabilityForSession(plainEnv(), otherUserId!);
    expect(cap).toBeNull();
  });

  it("end-to-end through the OAuth-mounted Worker (POST /capability) keys identically", async () => {
    // Belt-and-suspenders: also drive STORE through the FULL Worker entry point
    // (index.ts → OAuthProvider → google defaultHandler → /capability), with the
    // OAuth provider's `unwrapToken` faked at the env level, to confirm the route
    // wiring keys the row the same way the direct handler does — then load it by
    // the H3-resolved key. Uses a SECOND distinct human so it is independent of
    // the first test's row.
    const email = "seam-worker@example.com";
    const props: FulaAuthProps = { email, userId: await emailToUserId(email) };
    const summary = {
      userId: props.userId,
      scope: ["mcp"],
      grant: { clientId: "fxfiles", props },
    };

    // The Worker reads OAUTH_PROVIDER.unwrapToken off env; inject the fake there.
    const workerEnv = {
      ...(env as unknown as Record<string, unknown>),
      OAUTH_PROVIDER: {
        ...((env as unknown as { OAUTH_PROVIDER?: Record<string, unknown> }).OAUTH_PROVIDER ?? {}),
        unwrapToken: async () => summary,
      },
    };

    const ctx = createExecutionContext();
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(capabilityRequest(), workerEnv as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);

    const loadUserId = await resolveUserIdFromProps(props);
    expect(loadUserId).toBe(await emailToUserId(email));
    const cap = await loadCapabilityForSession(plainEnv(), loadUserId!);
    expect(cap).not.toBeNull();
    try {
      expect(cap!.get().refresh_token).toBe(CAP.refresh_token);
    } finally {
      cap!.dispose();
    }
  });
});
