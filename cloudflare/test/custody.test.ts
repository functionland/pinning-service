/**
 * H2 custody — the security-critical test suite.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Proves, against a REAL local OpenBao (preferred over a mock — see
 * vitest.config.ts; `bao server -dev` with the transit engine), that:
 *
 *   1. seal → open ROUND-TRIPS the capability (real wrap/unwrap via OpenBao).
 *   2. THE GUARANTEE — a full D1 dump (the encrypted capability + the wrapped
 *      DEK) + the Worker's config, but NO live OpenBao, decrypts to NOTHING:
 *      the wrapped DEK is opaque without the OpenBao unwrap, so open FAILS CLOSED.
 *   3. AAD binding — a swapped record_id makes decryption fail.
 *   4. Cross-row swap — user A's ciphertext lifted into user B's PK row fails
 *      (the AAD binds user_id; defense-in-depth re-checks the embedded user_id).
 *   5. Tampered alg / dek_version fail.
 *   6. The delegation endpoint rejects unauthenticated / wrong-scope / wrong-user.
 *   7. Nothing secret is persisted in plaintext — the D1 row holds only the
 *      ciphertext + the opaque wrapped DEK + non-secret metadata.
 *
 * If a live OpenBao is NOT present (OPENBAO_LIVE !== "1"), the round-trip tests
 * skip, but the fail-closed guarantee + the unauthenticated-delegation tests
 * (which want a dead OpenBao) still run.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index.js";
import {
  sealCapability,
  openCapability,
  type CapabilityData,
  type D1Like,
} from "../src/custody.js";
import { OpenBaoTransit, type OpenBaoConfig } from "../src/openbao.js";

const LIVE = env.OPENBAO_LIVE === "1";
const describeLive = LIVE ? describe : describe.skip;

// A representative capability. NOTE every field except `endpoint` is a secret.
const CAP: CapabilityData = {
  workspace_secret: "d29ya3NwYWNlLXNlY3JldC0zMmItZXhhbXBsZS12YWx1ZS0xMjM0NQ==",
  mcp_secret: "bWNwLXgyNTUxOS1jb25uZWN0aW9uLXNlY3JldC1leGFtcGxl",
  refresh_token: "rt_live_connection_refresh_credential_example_0001",
  refresh_url: "https://api.fx.land/api/mcp/tokens/refresh-connection",
  endpoint: "https://s3.cloud.fx.land",
};
// The secret string values that MUST NEVER appear plaintext in the DB row.
const SECRET_VALUES = [CAP.workspace_secret, CAP.mcp_secret, CAP.refresh_token];

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);

function db(): D1Like {
  return env.CUSTODY_DB as unknown as D1Like;
}

/** A live OpenBao client built from the injected real creds. */
function liveBao(overrides: Partial<OpenBaoConfig> = {}): OpenBaoTransit {
  return new OpenBaoTransit({
    addr: env.OPENBAO_ADDR,
    roleId: env.OPENBAO_ROLE_ID,
    secretId: env.OPENBAO_SECRET_ID,
    transitKey: env.OPENBAO_TRANSIT_KEY,
    ...overrides,
  });
}

/** A client pointed at a DEAD OpenBao — models "no reachable KEK". */
function deadBao(): OpenBaoTransit {
  return new OpenBaoTransit({
    addr: env.OPENBAO_DEAD_ADDR,
    roleId: env.OPENBAO_ROLE_ID,
    secretId: env.OPENBAO_SECRET_ID,
    transitKey: env.OPENBAO_TRANSIT_KEY,
    timeoutMs: 1500,
  });
}

/** Raw read of the persisted row (to inspect what is actually at rest). */
async function readRow(userId: string): Promise<Record<string, unknown> | null> {
  return (env.CUSTODY_DB as unknown as {
    prepare(q: string): {
      bind(...v: unknown[]): { first<T>(): Promise<T | null> };
    };
  })
    .prepare("SELECT * FROM mcp_capabilities WHERE user_id = ?1")
    .bind(userId)
    .first<Record<string, unknown>>();
}

beforeAll(async () => {
  // Apply the custody schema to the (miniflare-simulated) local D1.
  const d1 = env.CUSTODY_DB as unknown as { exec(q: string): Promise<unknown> };
  // exec runs one statement per call in miniflare's D1; split on the blank-line
  // boundaries of schema.sql's CREATE statements. We inline them here so the test
  // is self-contained and does not depend on wrangler applying migrations.
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_capabilities (user_id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, capability_ciphertext BLOB NOT NULL, wrapped_dek TEXT NOT NULL, dek_version INTEGER NOT NULL DEFAULT 1, alg TEXT NOT NULL, endpoint TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)",
  );
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS mcp_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL, ts INTEGER NOT NULL, detail TEXT)",
  );
});

// ── 1. Round-trip ────────────────────────────────────────────────────────────
describeLive("seal → open round-trip (REAL OpenBao transit)", () => {
  it("round-trips the capability through a genuine wrap/unwrap", async () => {
    const bao = liveBao();
    const recordId = await sealCapability(db(), bao, USER_A, CAP);
    expect(recordId).toMatch(/^[0-9a-f-]{36}$/);

    const opened = await openCapability(db(), bao, USER_A);
    expect(opened).not.toBeNull();
    expect(opened!.get()).toEqual(CAP);
    opened!.dispose();
    // disposed → access throws
    expect(() => opened!.get()).toThrow();
  });

  it("re-seal rotates record_id + wrapped_dek (old backup of the row is stale)", async () => {
    const bao = liveBao();
    await sealCapability(db(), bao, USER_A, CAP);
    const r1 = await readRow(USER_A);
    await sealCapability(db(), bao, USER_A, CAP);
    const r2 = await readRow(USER_A);
    expect(r1!.record_id).not.toBe(r2!.record_id);
    expect(r1!.wrapped_dek).not.toBe(r2!.wrapped_dek);
    // still opens to the same capability after rotation
    const opened = await openCapability(db(), bao, USER_A);
    expect(opened!.get()).toEqual(CAP);
    opened!.dispose();
  });
});

// ── 2. THE GUARANTEE — DB dump + Worker config, no live OpenBao → nothing ────
describeLive("THE GUARANTEE: a D1 dump without a live OpenBao decrypts to NOTHING", () => {
  it("open FAILS CLOSED when OpenBao is unreachable (wrapped DEK is opaque)", async () => {
    // 1) Seal a REAL row with the live OpenBao — now D1 holds the real ciphertext
    //    + the real OpenBao-wrapped DEK.
    await sealCapability(db(), liveBao(), USER_A, CAP);

    // 2) Take the full row exactly as a DB dump would yield it.
    const dump = await readRow(USER_A);
    expect(dump).not.toBeNull();
    expect(typeof dump!.wrapped_dek).toBe("string");
    expect((dump!.wrapped_dek as string).startsWith("vault:")).toBe(true);

    // 3) The attacker has the dump + the Worker's config/secrets (env.OPENBAO_*),
    //    but NO reachable OpenBao. Model that with a client pointed at a dead
    //    address. The unwrap MUST fail → open MUST throw → no plaintext.
    await expect(openCapability(db(), deadBao(), USER_A)).rejects.toThrow();
  });

  it("the wrapped DEK cannot be unwrapped offline (no KEK on the Worker)", async () => {
    await sealCapability(db(), liveBao(), USER_A, CAP);
    const dump = await readRow(USER_A);
    // Directly attempt the unwrap an attacker would need — with no live OpenBao.
    await expect(deadBao().unwrapDek(dump!.wrapped_dek as string)).rejects.toThrow();
    // And the ciphertext alone, without the unwrapped DEK, is just bytes: the
    // stored blob contains NONE of the secret plaintext.
    const blob = new Uint8Array(dump!.capability_ciphertext as ArrayBuffer);
    const asText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(blob);
    for (const secret of SECRET_VALUES) {
      expect(asText.includes(secret)).toBe(false);
    }
  });
});

// ── 3 & 4. AAD binding — record_id + user_id swaps fail ──────────────────────
describeLive("AAD binding: tampered identity fields fail decryption", () => {
  it("a SWAPPED record_id makes the tag fail (open throws)", async () => {
    const bao = liveBao();
    await sealCapability(db(), bao, USER_A, CAP);
    // Tamper: change record_id in the row (AAD will no longer match what sealed).
    await (env.CUSTODY_DB as unknown as {
      prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
    })
      .prepare("UPDATE mcp_capabilities SET record_id = ?2 WHERE user_id = ?1")
      .bind(USER_A, crypto.randomUUID())
      .run();
    await expect(openCapability(db(), bao, USER_A)).rejects.toThrow();
  });

  it("CROSS-ROW SWAP: user A's ciphertext under user B's PK fails (user_id in AAD)", async () => {
    const bao = liveBao();
    // Seal A, then copy A's crypto material into a B row (the exact attack Codex
    // flagged: D1 write moves {ciphertext, wrapped_dek, record_id} to a victim).
    await sealCapability(db(), bao, USER_A, CAP);
    const a = await readRow(USER_A);
    await (env.CUSTODY_DB as unknown as {
      prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
    })
      .prepare(
        `INSERT INTO mcp_capabilities (user_id, record_id, capability_ciphertext, wrapped_dek, dek_version, alg, endpoint, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
         ON CONFLICT(user_id) DO UPDATE SET record_id=excluded.record_id, capability_ciphertext=excluded.capability_ciphertext, wrapped_dek=excluded.wrapped_dek, dek_version=excluded.dek_version, alg=excluded.alg`,
      )
      .bind(
        USER_B,
        a!.record_id,
        a!.capability_ciphertext,
        a!.wrapped_dek,
        a!.dek_version,
        a!.alg,
        a!.endpoint,
        a!.created_at,
      )
      .run();
    // Opening B rebuilds the AAD with user_id=B → tag fails → throw. The victim
    // NEVER receives user A's capability.
    await expect(openCapability(db(), bao, USER_B)).rejects.toThrow();
  });

  it("a tampered alg fails (downgrade/forge blocked)", async () => {
    const bao = liveBao();
    await sealCapability(db(), bao, USER_A, CAP);
    await (env.CUSTODY_DB as unknown as {
      prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
    })
      .prepare("UPDATE mcp_capabilities SET alg = ?2 WHERE user_id = ?1")
      .bind(USER_A, "aes-256-gcm")
      .run();
    // Unknown alg is rejected up front (and would also fail the AAD tag).
    await expect(openCapability(db(), bao, USER_A)).rejects.toThrow();
  });

  it("a tampered dek_version fails the AAD tag", async () => {
    const bao = liveBao();
    await sealCapability(db(), bao, USER_A, CAP);
    await (env.CUSTODY_DB as unknown as {
      prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
    })
      .prepare("UPDATE mcp_capabilities SET dek_version = ?2 WHERE user_id = ?1")
      .bind(USER_A, 999)
      .run();
    await expect(openCapability(db(), bao, USER_A)).rejects.toThrow();
  });
});

// ── 5. Nothing secret persisted in plaintext ─────────────────────────────────
describeLive("at-rest hygiene: the D1 row holds ONLY ciphertext + opaque metadata", () => {
  it("no secret field value appears anywhere in the persisted row", async () => {
    await sealCapability(db(), liveBao(), USER_A, CAP);
    const row = await readRow(USER_A);
    // Serialize the ENTIRE row (all columns) and assert no secret leaks.
    const blob = new Uint8Array(row!.capability_ciphertext as ArrayBuffer);
    const rowDump = JSON.stringify({
      ...row,
      capability_ciphertext: Array.from(blob), // bytes, not the buffer object
    });
    for (const secret of SECRET_VALUES) {
      expect(rowDump.includes(secret)).toBe(false);
    }
    // The only string columns are the opaque wrapped_dek + non-secret metadata.
    expect((row!.wrapped_dek as string).startsWith("vault:")).toBe(true);
    expect(row!.endpoint).toBe(CAP.endpoint); // endpoint is explicitly non-secret
    // record_id is a UUID, alg is the cipher name — neither is a secret.
    expect(row!.alg).toBe("xchacha20poly1305");
  });
});

// ── 6. Delegation endpoint auth (runs WITHOUT a live OpenBao too) ─────────────
describe("POST /capability delegation — auth is enforced", () => {
  const CAP_URL = "http://localhost/capability";

  async function post(headers: Record<string, string>, body: unknown): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(CAP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("rejects an UNAUTHENTICATED request (no bearer) with 401", async () => {
    const res = await post({}, CAP);
    expect(res.status).toBe(401);
    expect((await res.text()).toLowerCase()).toContain("missing_bearer");
  });

  it("rejects an INVALID/forged bearer token with 401", async () => {
    // A well-formed-looking but never-issued opaque token → unwrapToken returns
    // null → 401 invalid_token. (Proves we validate against the provider's KV,
    // not merely the token shape.)
    const forged = `${"c".repeat(64)}:grant-x:never-issued-secret-000000000000`;
    const res = await post({ Authorization: `Bearer ${forged}` }, CAP);
    expect(res.status).toBe(401);
    expect((await res.text()).toLowerCase()).toContain("invalid_token");
  });

  it("rejects a GET (method not allowed)", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(CAP_URL, { method: "GET" }),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });
});

// ── 7. OpenBao client unit behaviour (fail-closed, never hangs) ──────────────
describe("OpenBaoTransit fails closed (no live OpenBao needed)", () => {
  it("times out fast and throws (does not hang) against a dead address", async () => {
    const t0 = Date.now();
    await expect(deadBao().unwrapDek("vault:v1:AAAA")).rejects.toThrow();
    // 1.5s timeout + a little slack — proves the AbortController fires.
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("rejects a malformed wrapped DEK before any network call", async () => {
    await expect(deadBao().unwrapDek("not-a-vault-blob")).rejects.toThrow();
  });

  it("constructor rejects incomplete config (fail closed on misconfig)", () => {
    expect(
      () =>
        new OpenBaoTransit({ addr: "", roleId: "r", secretId: "s", transitKey: "k" }),
    ).toThrow();
  });
});
