/**
 * Hosted-MCP collab bundle tests — C1 (store) + C2 (by-pubkey service-auth fetch).
 *
 * Two layers (same convention as mcpConnections.test.ts / collabWriteAuth.test.ts):
 *  1. PURE-LOGIC (always run, no DB) — the validator's fail-closed rules + the
 *     no-DB auth boundary (C1 unauth → 401; C2 without/with-bad service-auth →
 *     401; C2 valid-auth + malformed pubkey → 400, all short-circuit before any
 *     query). These carry the evidence even where Postgres isn't reachable.
 *  2. INTEGRATION (describe.runIf(pgAvailable)) — the HTTP round-trip: store →
 *     fetch; the CROSS-USER isolation gate (user B's valid service-auth cannot
 *     read user A's bundle → 404); revoked → 404; unpaired → 404; unauthorized
 *     group → 409; connection_id pubkey-mismatch → 404; overwrite; the base64url
 *     pubkey-in-path routing regression; Cache-Control: no-store; and that the
 *     minted collab token verifies + is scoped to the group.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import type { Express } from 'express';
import { createApp, generateJwtApiKey, type AppConfig } from '../server/app.js';
import {
  createPostgresPool,
  closePool,
  query,
  createApiKey,
  createMcpConnectionsTable,
  createMcpRevocationTable,
  createCollabManifestsTable,
  createCollabWriteAuthSchema,
} from '../server/database/postgres.js';
import { emailToUserId } from '../server/utils/hash.js';
import { validateBundlePayload, BUNDLE_WRAPPED_SECRET_MAX, BUNDLE_MANIFEST_KEY_MAX } from '../server/mcpBundle.js';
import { verifyCollabWriteToken } from '../server/collabTokens.js';

const JWT_SECRET = 'test-jwt-secret-for-testing-only';
const SERVICE_SECRET = 'fula-pin-svc-shared-test-secret-rotate-me';
const USER_ID = emailToUserId('bundle-test@example.com');
const USER_ID_B = emailToUserId('bundle-attacker@example.com');
// Real 32-byte X25519-shaped pubkeys, standard-base64 (FxFiles convention).
const MCP_PUB_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const G1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const G2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// Standard→base64url for a pubkey placed in a URL path segment.
const toPathPub = (std: string) => Buffer.from(std, 'base64').toString('base64url');

// Mirror the Fula S3 gateway (Rust) service-auth minter — the cross-language ref.
function mintServiceAuth(userId: string, secret: string, exp = Math.floor(Date.now() / 1000) + 300): string {
  const uidB64 = Buffer.from(userId).toString('base64url');
  const msg = `v1.${uidB64}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(msg).digest('base64url');
  return `${msg}.${sig}`;
}

// A complete, valid C1 body.
const validBody = (over: Record<string, unknown> = {}) => ({
  mcp_pub_b64: MCP_PUB_A,
  group_id: G1,
  manifest_bucket: 'fula-metadata-v8',
  manifest_key: '.fula/collab/' + G1 + '/manifest',
  webui_base: 'https://cloud.fx.land',
  wrapped_link_secret: '{"v":5,"id":"tok","sealed":"AAAA"}',
  ...over,
});

// ============================================================================
// 1a. PURE-LOGIC — validateBundlePayload
// ============================================================================

describe('validateBundlePayload — accepts a well-formed bundle', () => {
  it('returns the normalized payload and stores NO webui_base', () => {
    const r = validateBundlePayload(validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mcpPubB64).toBe(MCP_PUB_A); // canonical standard-base64
    expect(r.value.connectionId).toBeUndefined();
    expect(r.value.bundle).toEqual({
      group_id: G1,
      manifest_bucket: 'fula-metadata-v8',
      manifest_key: '.fula/collab/' + G1 + '/manifest',
      wrapped_link_secret: '{"v":5,"id":"tok","sealed":"AAAA"}',
    });
    // webui_base is accepted on input but NEVER part of the stored bundle.
    expect('webui_base' in (r.value.bundle as Record<string, unknown>)).toBe(false);
  });

  it('accepts a base64url pubkey and canonicalizes it to standard base64', () => {
    const urlPub = toPathPub(MCP_PUB_A);
    const r = validateBundlePayload(validBody({ mcp_pub_b64: urlPub }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mcpPubB64).toBe(MCP_PUB_A);
  });

  it('accepts an optional connection_id (UUID)', () => {
    const r = validateBundlePayload(validBody({ connection_id: G2 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.connectionId).toBe(G2);
  });

  it('accepts when webui_base is absent (C2 derives it server-side)', () => {
    const b = validBody();
    delete (b as Record<string, unknown>).webui_base;
    expect(validateBundlePayload(b).ok).toBe(true);
  });
});

describe('validateBundlePayload — fail-closed on every malformed field (400)', () => {
  const bad = (over: Record<string, unknown>, delKeys: string[] = []) => {
    const b = validBody(over) as Record<string, unknown>;
    for (const k of delKeys) delete b[k];
    const r = validateBundlePayload(b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  };

  it('rejects a non-object body', () => {
    expect(validateBundlePayload(undefined).ok).toBe(false);
    expect(validateBundlePayload('x').ok).toBe(false);
    expect(validateBundlePayload([]).ok).toBe(false);
  });

  it('rejects a bad mcp_pub_b64 (missing / too short / non-base64)', () => {
    bad({}, ['mcp_pub_b64']);
    bad({ mcp_pub_b64: 'too-short' });
    bad({ mcp_pub_b64: Buffer.alloc(31, 7).toString('base64') }); // 31 bytes
    bad({ mcp_pub_b64: 123 });
  });

  it('rejects a bad group_id (not a UUID)', () => {
    bad({ group_id: 'not-a-uuid' });
    bad({}, ['group_id']);
  });

  it('rejects a bad manifest_bucket (empty / illegal chars / ".." / too long)', () => {
    bad({ manifest_bucket: '' });
    bad({ manifest_bucket: 'has space' });
    bad({ manifest_bucket: 'a/b' });
    bad({ manifest_bucket: 'a..b' });
    bad({ manifest_bucket: '-leading-dash' }); // must start alphanumeric
    bad({ manifest_bucket: 'a'.repeat(256) });
    bad({ manifest_bucket: 42 });
  });

  it('rejects a bad manifest_key (empty / leading "/" / ".." segment / control char / too long)', () => {
    bad({ manifest_key: '' });
    bad({ manifest_key: '/leading' });
    bad({ manifest_key: 'a/../b' });
    bad({ manifest_key: 'a' + String.fromCharCode(1) + 'b' }); // C0 control char
    bad({ manifest_key: 'a' + String.fromCharCode(0) + 'b' }); // NUL
    bad({ manifest_key: 'k'.repeat(BUNDLE_MANIFEST_KEY_MAX + 1) });
    bad({ manifest_key: 99 });
  });

  it('rejects a bad wrapped_link_secret (empty / too long / NUL)', () => {
    bad({ wrapped_link_secret: '' });
    bad({ wrapped_link_secret: 'x'.repeat(BUNDLE_WRAPPED_SECRET_MAX + 1) });
    bad({ wrapped_link_secret: 'a' + String.fromCharCode(0) + 'b' }); // NUL rejected
    bad({ wrapped_link_secret: {} });
  });

  it('a wrapped_link_secret with newlines/tabs (pretty-printed JSON) is ALLOWED', () => {
    const pretty = '{\n\t"v": 5\n}';
    expect(validateBundlePayload(validBody({ wrapped_link_secret: pretty })).ok).toBe(true);
  });

  it('rejects a bad webui_base (non-URL / non-http scheme / too long) when present', () => {
    bad({ webui_base: 'not a url' });
    bad({ webui_base: 'ftp://cloud.fx.land' });
    bad({ webui_base: 'file:///etc/passwd' });
    bad({ webui_base: 'https://' + 'a'.repeat(512) + '.com' });
  });

  it('rejects a bad connection_id (not a UUID) when present', () => {
    bad({ connection_id: 'nope' });
  });
});

// ============================================================================
// 1b. NO-DB auth boundary — 401/400 that short-circuit before any query
// ============================================================================

let pgAvailable = false;
try {
  const pool = createPostgresPool();
  const client = await pool.connect();
  client.release();
  pgAvailable = true;
} catch {
  console.warn('[test] PostgreSQL not available — skipping MCP bundle integration tests');
  await closePool();
}

const testConfig: AppConfig = {
  port: 3097,
  googleClientId: 'test-google-client-id',
  sessionSecret: 'test-session-secret-for-testing-only',
  jwtSecret: JWT_SECRET,
  nodeEnv: 'test',
  pinningServiceUrl: 'http://localhost:6000',
  mcpTokenTtlSeconds: 3600,
  systemKey: 'test-system-key-12345',
  pinServiceSecret: SERVICE_SECRET,
};

describe('MCP bundle endpoints — auth boundary (no DB)', () => {
  let app: Express;
  beforeAll(() => {
    app = createApp(testConfig, { skipRateLimit: true }).app;
  });

  it('C1 POST /api/mcp/connections/bundle → 401 unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/connections/bundle').send(validBody());
    expect(res.status).toBe(401);
  });

  it('C2 GET .../by-pubkey/:pubkey/bundle → 401 without a service-auth header', async () => {
    const res = await request(app).get(`/api/mcp/connections/by-pubkey/${toPathPub(MCP_PUB_A)}/bundle`);
    expect(res.status).toBe(401);
  });

  it('C2 → 401 with a bad service-auth header (wrong secret)', async () => {
    const badHeader = mintServiceAuth(USER_ID, 'the-wrong-secret');
    const res = await request(app)
      .get(`/api/mcp/connections/by-pubkey/${toPathPub(MCP_PUB_A)}/bundle`)
      .set('X-Fula-Service-Auth', badHeader);
    expect(res.status).toBe(401);
  });

  it('C2 → 401 with a garbage service-auth header', async () => {
    const res = await request(app)
      .get(`/api/mcp/connections/by-pubkey/${toPathPub(MCP_PUB_A)}/bundle`)
      .set('X-Fula-Service-Auth', 'not-a-valid-header');
    expect(res.status).toBe(401);
  });

  it('C2 → 400 on a malformed pubkey (valid service-auth, fails before any query)', async () => {
    const res = await request(app)
      .get('/api/mcp/connections/by-pubkey/tooshort/bundle')
      .set('X-Fula-Service-Auth', mintServiceAuth(USER_ID, SERVICE_SECRET));
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// 2. INTEGRATION — the HTTP round-trip (requires Postgres)
// ============================================================================

describe.runIf(pgAvailable)('MCP bundle — endpoints', () => {
  let app: Express;

  beforeAll(async () => {
    app = createApp(testConfig, { skipRateLimit: true }).app;
    await createMcpConnectionsTable();
    await createMcpRevocationTable();
    await createCollabManifestsTable();
    await createCollabWriteAuthSchema();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await query('DELETE FROM mcp_connections').catch(() => {});
    await query('DELETE FROM collab_manifests').catch(() => {});
    await query('DELETE FROM api_keys').catch(() => {});
  });

  const makeBearer = (userId: string) => createApiKey(userId, JWT_SECRET, generateJwtApiKey);

  async function pair(bearer: string, pub = MCP_PUB_A) {
    const res = await request(app).post('/api/mcp/tokens').set('Authorization', `Bearer ${bearer}`).send({ mcp_pub_b64: pub });
    expect(res.status).toBe(200);
    return { connectionId: res.body.connectionId as string, refreshToken: res.body.refreshToken as string };
  }

  async function createGroup(groupId: string, creatorBearer: string) {
    const res = await request(app)
      .put(`/api/collab/${groupId}/manifest-sync`)
      .set('Authorization', `Bearer ${creatorBearer}`)
      .send({ encryptedManifest: 'seed' });
    expect(res.status).toBe(200);
  }

  const authorize = (bearer: string, connectionId: string, groupIds: string[]) =>
    request(app).post(`/api/mcp/connections/${connectionId}/collab-groups`).set('Authorization', `Bearer ${bearer}`).send({ groupIds });

  const storeBundle = (bearer: string, body: Record<string, unknown>) =>
    request(app).post('/api/mcp/connections/bundle').set('Authorization', `Bearer ${bearer}`).send(body);

  const fetchBundle = (authUserId: string, pubStd: string) =>
    request(app)
      .get(`/api/mcp/connections/by-pubkey/${toPathPub(pubStd)}/bundle`)
      .set('X-Fula-Service-Auth', mintServiceAuth(authUserId, SERVICE_SECRET));

  // Full happy path: pair → group → authorize → C1 store → C2 fetch.
  async function fullPair(bearer: string, pub = MCP_PUB_A, groupId = G1) {
    await createGroup(groupId, bearer);
    const { connectionId } = await pair(bearer, pub);
    const auth = await authorize(bearer, connectionId, [groupId]);
    expect(auth.status).toBe(200);
    const stored = await storeBundle(bearer, validBody({ mcp_pub_b64: pub, group_id: groupId, connection_id: connectionId }));
    expect(stored.status).toBe(200);
    return { connectionId };
  }

  it('C1 stores a bundle; C2 returns it with a server-derived webui_base + a scoped collab token', async () => {
    const bearer = await makeBearer(USER_ID);
    const { connectionId } = await fullPair(bearer);

    const res = await fetchBundle(USER_ID, MCP_PUB_A);
    expect(res.status).toBe(200);
    // The bundle fields round-trip (snake_case, as the Worker's validateBundle expects).
    expect(res.body.group_id).toBe(G1);
    expect(res.body.manifest_bucket).toBe('fula-metadata-v8');
    expect(res.body.manifest_key).toBe('.fula/collab/' + G1 + '/manifest');
    expect(res.body.wrapped_link_secret).toBe('{"v":5,"id":"tok","sealed":"AAAA"}');
    // webui_base is SERVER-derived (the request origin), not the client value.
    expect(typeof res.body.webui_base).toBe('string');
    expect(res.body.webui_base).toMatch(/^https?:\/\//);
    // A fresh collab-write token, scoped to the authorized group + bound to the row.
    expect(typeof res.body.collab_write_token).toBe('string');
    const claims = verifyCollabWriteToken(res.body.collab_write_token, JWT_SECRET, { expectedSub: USER_ID });
    expect(claims.collab.groupIds).toEqual([G1]);
    expect(claims.collab.cid).toBe(connectionId);
    expect(res.body.collab_group_ids).toEqual([G1]);
  });

  it('CROSS-USER ISOLATION: user B\'s valid service-auth CANNOT read user A\'s bundle → 404', async () => {
    const bearerA = await makeBearer(USER_ID);
    await fullPair(bearerA); // A pairs pubkey MCP_PUB_A + stores a bundle

    // A (the owner) can read it.
    expect((await fetchBundle(USER_ID, MCP_PUB_A)).status).toBe(200);
    // B, with a perfectly valid service-auth for THEMSELVES, asks for the SAME
    // pubkey → the (user_id, pubkey) SQL filter yields nothing → 404 (no oracle).
    const asB = await fetchBundle(USER_ID_B, MCP_PUB_A);
    expect(asB.status).toBe(404);
  });

  it('pubkey COLLISION across users stays isolated: A and B each get THEIR OWN bundle for a shared pubkey', async () => {
    // The adversarial case: BOTH users pair a connection with the SAME pubkey and
    // each stores a distinct bundle. Because every query also filters user_id, A's
    // fetch returns A's row and B's fetch returns B's row — a shared pubkey never
    // crosses the user boundary.
    const bearerA = await makeBearer(USER_ID);
    const bearerB = await makeBearer(USER_ID_B);
    await fullPair(bearerA, MCP_PUB_A, G1); // A: connection with MCP_PUB_A, bundle for G1
    await fullPair(bearerB, MCP_PUB_A, G2); // B: SAME pubkey, bundle for G2

    const asA = await fetchBundle(USER_ID, MCP_PUB_A);
    expect(asA.status).toBe(200);
    expect(asA.body.group_id).toBe(G1); // A sees ONLY A's bundle

    const asB2 = await fetchBundle(USER_ID_B, MCP_PUB_A);
    expect(asB2.status).toBe(200);
    expect(asB2.body.group_id).toBe(G2); // B sees ONLY B's bundle
  });

  it('C2 → 404 once the connection is revoked', async () => {
    const bearer = await makeBearer(USER_ID);
    const { connectionId } = await fullPair(bearer);
    expect((await fetchBundle(USER_ID, MCP_PUB_A)).status).toBe(200);

    await request(app).post(`/api/mcp/connections/${connectionId}/revoke`).set('Authorization', `Bearer ${bearer}`).send({});
    expect((await fetchBundle(USER_ID, MCP_PUB_A)).status).toBe(404);
  });

  it('C2 → 404 when no bundle was ever stored (paired only)', async () => {
    const bearer = await makeBearer(USER_ID);
    await pair(bearer, MCP_PUB_A); // paired, but no bundle
    expect((await fetchBundle(USER_ID, MCP_PUB_A)).status).toBe(404);
  });

  it('C1 → 404 when the pubkey has no connection (pair first)', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await storeBundle(bearer, validBody());
    expect(res.status).toBe(404);
  });

  it('C1 → 409 when the bundle group_id is NOT authorized on the connection', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer, MCP_PUB_A);
    await authorize(bearer, connectionId, [G1]); // authorized for G1 only
    // Try to store a bundle for G2 (never authorized) → 409.
    const res = await storeBundle(bearer, validBody({ group_id: G2, connection_id: connectionId }));
    expect(res.status).toBe(409);
  });

  it('C1 with connection_id → 404 on a pubkey mismatch (secret wrapped to a different key)', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer, MCP_PUB_A);
    await authorize(bearer, connectionId, [G1]);
    // connection_id points at the MCP_PUB_A row, but the body claims a different pubkey.
    const otherPub = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64');
    const res = await storeBundle(bearer, validBody({ mcp_pub_b64: otherPub, group_id: G1, connection_id: connectionId }));
    expect(res.status).toBe(404);
  });

  it('C1 overwrite: the latest bundle wins (MVP one-group-per-agent)', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer, MCP_PUB_A);
    await authorize(bearer, connectionId, [G1]);
    await storeBundle(bearer, validBody({ connection_id: connectionId, manifest_key: 'first/manifest' }));
    await storeBundle(bearer, validBody({ connection_id: connectionId, manifest_key: 'second/manifest' }));
    const res = await fetchBundle(USER_ID, MCP_PUB_A);
    expect(res.status).toBe(200);
    expect(res.body.manifest_key).toBe('second/manifest');
  });

  it('ROUTING REGRESSION: a pubkey whose STANDARD base64 has "/" and "+" round-trips as base64url in the path', async () => {
    // 0xFB,0xFF,0xFF… → base64 starts "+//…" (contains BOTH '+' and '/').
    const slashBuf = Buffer.from([0xfb, ...Array(31).fill(0xff)]);
    const slashStd = slashBuf.toString('base64');
    expect(slashStd).toMatch(/\+/);
    expect(slashStd).toMatch(/\//);

    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer, slashStd); // stored canonical = slashStd
    await authorize(bearer, connectionId, [G1]);
    const stored = await storeBundle(bearer, validBody({ mcp_pub_b64: slashStd, group_id: G1, connection_id: connectionId }));
    expect(stored.status).toBe(200);

    // C2 fetches with the base64url form in the path (no '/' or '+' in the URL).
    const res = await fetchBundle(USER_ID, slashStd);
    expect(res.status).toBe(200);
    expect(res.body.group_id).toBe(G1);
  });

  it('C2 sets Cache-Control: no-store (a bearer token must not be cached)', async () => {
    const bearer = await makeBearer(USER_ID);
    await fullPair(bearer);
    const res = await fetchBundle(USER_ID, MCP_PUB_A);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('C2 → 404 after the bundle group is de-authorized (de-auth revokes READ + write, not just writes)', async () => {
    const bearer = await makeBearer(USER_ID);
    const { connectionId } = await fullPair(bearer);
    expect((await fetchBundle(USER_ID, MCP_PUB_A)).status).toBe(200); // works before de-auth
    // Remove the group from the connection AFTER the bundle was stored.
    const del = await request(app)
      .delete(`/api/mcp/connections/${connectionId}/collab-groups`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ groupIds: [G1] });
    expect(del.status).toBe(200);
    // The bundle's group is no longer authorized → the stale bundle is withheld.
    expect((await fetchBundle(USER_ID, MCP_PUB_A)).status).toBe(404);
  });

  it('C1 never leaks the wrapped secret or a token into logs is not asserted here, but the response shape is minimal', async () => {
    const bearer = await makeBearer(USER_ID);
    const { connectionId } = await fullPair(bearer);
    const res = await fetchBundle(USER_ID, MCP_PUB_A);
    // The C2 projection returns ONLY bundle fields + collab token fields — never
    // the connection id, label, or refresh hash.
    expect(res.body.id).toBeUndefined();
    expect(res.body.label).toBeUndefined();
    expect(res.body.refresh_token_hash).toBeUndefined();
    expect(res.body.connectionId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(connectionId);
  });
});
