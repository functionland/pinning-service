/**
 * Store ⇄ load capability KEYING SEAM — the cross-agent proof (collab rework).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * THE SEAM: the `user_id` a connection's custody is STORED under (the
 * `POST /collab/bundle` delivery → `storeCollabBundle`, and the
 * `GET /collab/connection` keypair seal) MUST be byte-identical to the `user_id`
 * it is LOADED by (every MCP tool via `mcp.ts resolveUserIdFromProps` →
 * `loadCollabSession` / `loadCollabCustody`). If they differ, an AI OAuth-connects
 * but every tool call fails "no collaboration group connected" — a silent seam.
 *
 *   STORE keying: userId = emailToUserId(props.email)   (cross-checked == token sub)
 *   LOAD  keying: props.userId (a 64-hex) ELSE emailToUserId(props.email)
 *
 * Both sides read the SAME decrypted OAuth grant `props`, which `google.ts` sets
 * ONCE at federation as `{ email: email.toLowerCase(), userId: emailToUserId(email) }`,
 * so the two keyings CONVERGE. This test proves it end-to-end against the REAL
 * store + load paths (no replicated keying logic), with a deterministic in-memory
 * OpenBao mock so the gate ALWAYS runs (the seam dimension — user_id through the D1
 * PK + the AEAD AAD — is fully real; OpenBao only wraps the per-record DEK).
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";

// ── Mock ONLY the OpenBao transit factory — file-scoped, deterministic ────────
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
    openBaoFromEnv: () => mockBao,
    OpenBaoTransit: class {},
    OpenBaoError: class extends Error {},
  };
});

import {
  handleCollabConnection,
  handleCollabBundle,
  loadCollabCustody,
  type CapabilityEnv,
  type CollabBundleData,
} from "../src/capability.js";
import { emailToUserId } from "../src/userId.js";
import { resolveUserIdFromProps, resolveClientIdFromProps, type FulaAuthProps } from "../src/mcp.js";
import type { D1Like } from "../src/custody.js";

// The same human on BOTH sides of the seam.
const EMAIL = "seam-test@example.com";

// A representative bundle. We round-trip a KNOWN field (refresh_token) at the end
// to prove decrypt fidelity.
const BUNDLE: CollabBundleData = {
  webui_base: "https://cloud.fx.land",
  group_id: "1b9d7c2e-0000-4000-8000-000000000abc",
  manifest_bucket: "fula-metadata",
  manifest_key: "manifests/1b9d7c2e.json",
  wrapped_link_secret: '{"encapsulated_key":{"ephemeral_public":"AA"},"ciphertext":"BB"}',
  refresh_url: "https://api.fx.land/api/mcp/tokens/refresh-connection",
  refresh_token: "rt_seam_known_field_to_round_trip_0xDEADBEEF_0001",
};

function db(): D1Like {
  return env.CUSTODY_DB as unknown as D1Like;
}

function envWith(summary: unknown): CapabilityEnv {
  return {
    ...(env as unknown as CapabilityEnv),
    OAUTH_PROVIDER: { unwrapToken: async () => summary } as unknown as CapabilityEnv["OAUTH_PROVIDER"],
  };
}
function plainEnv(): CapabilityEnv {
  return env as unknown as CapabilityEnv;
}

function connectionRequest(): Request {
  return new Request("http://localhost/collab/connection", {
    method: "GET",
    headers: { Authorization: "Bearer seam-token" },
  });
}
function bundleRequest(body: unknown = BUNDLE): Request {
  return new Request("http://localhost/collab/bundle", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer seam-token" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const d1 = env.CUSTODY_DB as unknown as { exec(q: string): Promise<unknown> };
  await d1.exec("DROP TABLE IF EXISTS mcp_capabilities");
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_capabilities (user_id TEXT NOT NULL, client_id TEXT NOT NULL, record_id TEXT NOT NULL, capability_ciphertext BLOB NOT NULL, wrapped_dek TEXT NOT NULL, dek_version INTEGER NOT NULL DEFAULT 1, alg TEXT NOT NULL, endpoint TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, PRIMARY KEY (user_id, client_id))",
  );
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL, ts INTEGER NOT NULL, detail TEXT)",
  );
  void db; // keep the helper referenced
});

describe("resolveClientIdFromProps — fail-closed per-AI keying (the live tool-dispatch path)", () => {
  const base: FulaAuthProps = { email: "x@y.z", userId: "a".repeat(64) };
  it("returns the client_id for well-formed props", () => {
    expect(resolveClientIdFromProps({ ...base, clientId: "https://claude.ai" })).toBe("https://claude.ai");
  });
  it("returns null (fail closed) when client_id is absent / empty / non-string / over-length", () => {
    expect(resolveClientIdFromProps(base)).toBeNull();
    expect(resolveClientIdFromProps({ ...base, clientId: "" })).toBeNull();
    expect(resolveClientIdFromProps({ ...base, clientId: 123 as unknown as string })).toBeNull();
    expect(resolveClientIdFromProps({ ...base, clientId: "a".repeat(2049) })).toBeNull();
    expect(resolveClientIdFromProps(undefined)).toBeNull();
  });
});

describe("store ⇄ load collab-connection keying seam (always-on; mock OpenBao)", () => {
  it("CONNECT + deliver bundle, then LOAD by the H3-resolved key round-trips for the same human", async () => {
    // Build the grant `props` EXACTLY as google.ts does at federation.
    const lowered = EMAIL.toLowerCase();
    const props: FulaAuthProps = { email: lowered, name: "Seam Tester", userId: await emailToUserId(lowered), clientId: "fxfiles" };
    const summary = { userId: props.userId, scope: ["mcp"], grant: { clientId: "fxfiles", props } };

    // STORE — drive the REAL connect handlers: keypair seal, then bundle re-seal.
    const conn = await handleCollabConnection(connectionRequest(), envWith(summary));
    expect(conn.status).toBe(200);
    const res = await handleCollabBundle(bundleRequest(), envWith(summary));
    expect(res.status).toBe(204);

    // LOAD — derive the user_id the REAL H3 way, then load+decrypt the custody.
    const loadUserId = await resolveUserIdFromProps(props);
    expect(loadUserId).not.toBeNull();

    // THE SEAM: store key == load key, byte for byte.
    expect(loadUserId).toBe(await emailToUserId(props.email));
    expect(loadUserId).toMatch(/^[0-9a-f]{64}$/);

    // THE PROOF: the load finds + decrypts what the store sealed (keypair + bundle).
    const cap = await loadCollabCustody(plainEnv(), loadUserId!, "fxfiles");
    expect(cap).not.toBeNull();
    try {
      expect(typeof cap!.get().mcp_secret_b64).toBe("string");
      expect(cap!.get().bundle?.refresh_token).toBe(BUNDLE.refresh_token);
      expect(cap!.get().bundle?.group_id).toBe(BUNDLE.group_id);
    } finally {
      cap!.dispose();
    }
  });

  it("a DIFFERENT human's session loads NOTHING (the key truly partitions custody)", async () => {
    const otherProps: FulaAuthProps = {
      email: "someone-else@example.com",
      userId: await emailToUserId("someone-else@example.com"),
    };
    const otherUserId = await resolveUserIdFromProps(otherProps);
    expect(otherUserId).not.toBe(await emailToUserId(EMAIL.toLowerCase()));
    const cap = await loadCollabCustody(plainEnv(), otherUserId!, "fxfiles");
    expect(cap).toBeNull();
  });

  it("two AI clients for the SAME human get DISTINCT, isolated custody (claude ≠ chatgpt), EXECUTED", async () => {
    // The per-AI isolation the whole feature promises — proven through the REAL
    // store/load path with a mock OpenBao, so it runs WITHOUT a live KEK.
    const lowered = EMAIL.toLowerCase();
    const uid = await emailToUserId(lowered);
    const CLAUDE = "https://claude.ai";
    const CHATGPT = "https://chatgpt.com";
    const sum = (clientId: string) => ({
      userId: uid,
      scope: ["mcp"],
      grant: { clientId, props: { email: lowered, userId: uid, clientId } as FulaAuthProps },
    });

    // Each AI establishes its OWN connection keypair (same human, distinct client_id).
    const cClaude = await handleCollabConnection(connectionRequest(), envWith(sum(CLAUDE)));
    const cChatgpt = await handleCollabConnection(connectionRequest(), envWith(sum(CHATGPT)));
    expect(cClaude.status).toBe(200);
    expect(cChatgpt.status).toBe(200);
    const idClaude = (await cClaude.json()) as { mcp_pub_b64: string };
    const idChatgpt = (await cChatgpt.json()) as { mcp_pub_b64: string };
    // DISTINCT public keys → distinct identities.
    expect(idClaude.mcp_pub_b64).not.toBe(idChatgpt.mcp_pub_b64);

    // Deliver a bundle to CLAUDE only.
    expect((await handleCollabBundle(bundleRequest(), envWith(sum(CLAUDE)))).status).toBe(204);

    // CLAUDE's custody has the bundle + its own secret; CHATGPT's is its OWN and
    // has NO bundle — loading (uid, CHATGPT) never sees CLAUDE's data.
    const capClaude = await loadCollabCustody(plainEnv(), uid, CLAUDE);
    const capChatgpt = await loadCollabCustody(plainEnv(), uid, CHATGPT);
    expect(capClaude).not.toBeNull();
    expect(capChatgpt).not.toBeNull();
    try {
      expect(capClaude!.get().bundle?.group_id).toBe(BUNDLE.group_id);
      expect(capChatgpt!.get().bundle).toBeUndefined();
      expect(capClaude!.get().mcp_secret_b64).not.toBe(capChatgpt!.get().mcp_secret_b64);
    } finally {
      capClaude?.dispose();
      capChatgpt?.dispose();
    }
  });

  it("end-to-end through the OAuth-mounted Worker keys identically", async () => {
    const email = "seam-worker@example.com";
    const props: FulaAuthProps = { email, userId: await emailToUserId(email), clientId: "fxfiles" };
    const summary = { userId: props.userId, scope: ["mcp"], grant: { clientId: "fxfiles", props } };

    const workerEnv = {
      ...(env as unknown as Record<string, unknown>),
      OAUTH_PROVIDER: {
        ...((env as unknown as { OAUTH_PROVIDER?: Record<string, unknown> }).OAUTH_PROVIDER ?? {}),
        unwrapToken: async () => summary,
      },
    };

    const worker = (await import("../src/index.js")).default;
    // Connect (keypair) then deliver the bundle, both through the full Worker entry.
    let ctx = createExecutionContext();
    const conn = await worker.fetch(connectionRequest(), workerEnv as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(conn.status).toBe(200);

    ctx = createExecutionContext();
    const res = await worker.fetch(bundleRequest(), workerEnv as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);

    const loadUserId = await resolveUserIdFromProps(props);
    expect(loadUserId).toBe(await emailToUserId(email));
    const cap = await loadCollabCustody(plainEnv(), loadUserId!, "fxfiles");
    expect(cap).not.toBeNull();
    try {
      expect(cap!.get().bundle?.refresh_token).toBe(BUNDLE.refresh_token);
    } finally {
      cap!.dispose();
    }
  });
});
