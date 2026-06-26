/**
 * Collab-write auth tests — a GROUP-SCOPED AI token authorizes collab WRITES.
 *
 * Two layers (same convention as mcpConnections.test.ts / mcpTokens.test.ts):
 *  1. PURE-LOGIC (always run, no DB) — carries the SECURITY EVIDENCE so the PR
 *     is provable even where Postgres isn't reachable: mint/verify round-trip,
 *     the cross-token-confusion guard (an mcp_s3 token is cryptographically
 *     rejected by the collab verifier and vice-versa — domain-separated key +
 *     aud/typ/token_use), the cnf-required + tamper guards, TTL clamp, group
 *     membership, and the "scope comes ONLY from the stored row" invariant.
 *  2. INTEGRATION (describe.runIf(pgAvailable)) — the HTTP routes: authorize →
 *     mint, write to authorized group (200) on the DB-only manifest-sync route,
 *     403 on a non-authorized group / revoked connection / revoked group / a
 *     removed group (DB-truth), the cross-product (mcp_s3 → collab routes and
 *     collab → storage/DELETE routes all 401/403), the human regression path,
 *     CAS (stale If-Match → 409; absent → as before), and the audit row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
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
import { mintMcpToken, verifyMcpToken, decodeJwtHeader } from '../server/mcpTokens.js';
import {
  mintCollabWriteToken,
  verifyCollabWriteToken,
  isGroupAuthorizedByToken,
  normalizeGroupIds,
  resolveCollabTtlSeconds,
  deriveCollabSigningKey,
  COLLAB_TOKEN_TYP,
  COLLAB_TOKEN_USE,
  COLLAB_TOKEN_AUD,
  COLLAB_TOKEN_ISS,
  COLLAB_SCOPE_VERSION,
  COLLAB_TOKEN_TTL_DEFAULT_SECONDS,
  COLLAB_TOKEN_TTL_MIN_SECONDS,
  COLLAB_TOKEN_TTL_MAX_SECONDS,
  COLLAB_MAX_GROUP_IDS,
} from '../server/collabTokens.js';
import { mintCollabFromConnection } from '../server/mcpConnections.js';

const JWT_SECRET = 'test-jwt-secret-for-testing-only';
const USER_ID = emailToUserId('collab-write-test@example.com');
const MCP_PUB_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const CID = '11111111-2222-3333-4444-555555555555';
const G1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const G2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const G3 = 'cccccccc-3333-4333-8333-cccccccccccc';

// ============================================================================
// 1. PURE-LOGIC — the token primitives + the security boundary (no DB)
// ============================================================================

describe('collab token — mint/verify round-trip + claim shape', () => {
  it('mints a verifiable token with the exact contract claims', () => {
    const { token, claims } = mintCollabWriteToken(USER_ID, JWT_SECRET, {
      connectionId: CID,
      groupIds: [G1, G2],
      mcpPubB64: MCP_PUB_A,
    });
    const v = verifyCollabWriteToken(token, JWT_SECRET, { expectedSub: USER_ID });
    expect(v.iss).toBe(COLLAB_TOKEN_ISS);
    expect(v.aud).toBe(COLLAB_TOKEN_AUD);
    expect(v.token_use).toBe(COLLAB_TOKEN_USE);
    expect(v.sub).toBe(USER_ID);
    expect(v.collab.v).toBe(COLLAB_SCOPE_VERSION);
    expect(v.collab.cid).toBe(CID);
    expect(v.collab.groupIds).toEqual([G1, G2]); // lowercased, deduped
    expect(v.cnf.mcp_pub_b64).toBe(MCP_PUB_A);
    // The JOSE header carries the explicit media type discriminator.
    expect(decodeJwtHeader(token)?.typ).toBe(COLLAB_TOKEN_TYP);
    expect(decodeJwtHeader(token)?.alg).toBe('HS256');
    // Default TTL is short (<=10 min).
    expect(claims.exp - claims.iat).toBe(COLLAB_TOKEN_TTL_DEFAULT_SECONDS);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it('dedupes groupIds (exact) in the token', () => {
    const { token } = mintCollabWriteToken(USER_ID, JWT_SECRET, {
      connectionId: CID,
      groupIds: [G1, G1, G2],
      mcpPubB64: MCP_PUB_A,
    });
    const v = verifyCollabWriteToken(token, JWT_SECRET);
    expect(v.collab.groupIds).toEqual([G1, G2]);
  });

  it('isGroupAuthorizedByToken is EXACT (case-sensitive) and rejects non-members', () => {
    const { token } = mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: [G1], mcpPubB64: MCP_PUB_A });
    const v = verifyCollabWriteToken(token, JWT_SECRET);
    expect(isGroupAuthorizedByToken(v, G1)).toBe(true);
    // Case-sensitive: an uppercased id is a DIFFERENT group (storage keys by
    // the exact id), so it is NOT authorized.
    expect(isGroupAuthorizedByToken(v, G1.toUpperCase())).toBe(false);
    expect(isGroupAuthorizedByToken(v, G2)).toBe(false);
  });

  it('mint FAILS CLOSED: empty groups / bad UUID / bad pubkey / empty cid all throw', () => {
    expect(() => mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: [], mcpPubB64: MCP_PUB_A })).toThrow();
    expect(() => mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: ['not-a-uuid'], mcpPubB64: MCP_PUB_A })).toThrow();
    expect(() => mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: [G1], mcpPubB64: 'too-short' })).toThrow();
    expect(() => mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: '', groupIds: [G1], mcpPubB64: MCP_PUB_A })).toThrow();
  });

  it('TTL clamps to [60, 600] (short by mandate)', () => {
    expect(resolveCollabTtlSeconds(undefined)).toBe(COLLAB_TOKEN_TTL_DEFAULT_SECONDS);
    expect(resolveCollabTtlSeconds(5)).toBe(COLLAB_TOKEN_TTL_MIN_SECONDS);
    expect(resolveCollabTtlSeconds(99999)).toBe(COLLAB_TOKEN_TTL_MAX_SECONDS);
    expect(COLLAB_TOKEN_TTL_MAX_SECONDS).toBeLessThanOrEqual(600);
  });

  it('normalizeGroupIds rejects non-UUIDs and over-cap, dedupes (exact)', () => {
    expect(normalizeGroupIds([G1, G1])).toEqual([G1]);
    expect(() => normalizeGroupIds(['nope'])).toThrow();
    expect(() => normalizeGroupIds('not-an-array' as unknown)).toThrow();
    const tooMany = Array.from({ length: COLLAB_MAX_GROUP_IDS + 1 }, () =>
      `${'a'.repeat(8)}-1111-4111-8111-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    );
    expect(() => normalizeGroupIds(tooMany)).toThrow();
  });
});

describe('collab token — CROSS-TOKEN CONFUSION guard (the security boundary)', () => {
  it('an mcp_s3 gateway token is REJECTED by the collab verifier (different signing key + aud)', () => {
    const { token: mcpS3 } = mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: MCP_PUB_A });
    // Cryptographic separation: signed with the RAW secret, so it fails the
    // collab verifier's DERIVED-key signature check (before aud even matters).
    expect(() => verifyCollabWriteToken(mcpS3, JWT_SECRET)).toThrow();
  });

  it('a collab_write token is REJECTED by the mcp_s3 verifier (different signing key + aud)', () => {
    const { token: collab } = mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: [G1], mcpPubB64: MCP_PUB_A });
    expect(() => verifyMcpToken(collab, JWT_SECRET)).toThrow();
  });

  it('a collab-claims token signed with the RAW secret (not the derived key) is rejected', () => {
    // Simulate a confusion attempt: correct claims/typ but signed with the raw
    // shared secret. The derived-key verify must reject it.
    const now = Math.floor(Date.now() / 1000);
    const forged = jwt.sign(
      { iss: COLLAB_TOKEN_ISS, aud: COLLAB_TOKEN_AUD, sub: USER_ID, jti: 'x', iat: now, nbf: now, exp: now + 300,
        token_use: COLLAB_TOKEN_USE, collab: { v: 1, cid: CID, groupIds: [G1] }, cnf: { mcp_pub_b64: MCP_PUB_A } },
      JWT_SECRET, // RAW secret — wrong key
      { algorithm: 'HS256', header: { alg: 'HS256', typ: COLLAB_TOKEN_TYP } },
    );
    expect(() => verifyCollabWriteToken(forged, JWT_SECRET)).toThrow();
  });

  it('cnf is REQUIRED: a collab token without cnf is rejected (forged-token guard)', () => {
    const now = Math.floor(Date.now() / 1000);
    const noCnf = jwt.sign(
      { iss: COLLAB_TOKEN_ISS, aud: COLLAB_TOKEN_AUD, sub: USER_ID, jti: 'x', iat: now, nbf: now, exp: now + 300,
        token_use: COLLAB_TOKEN_USE, collab: { v: 1, cid: CID, groupIds: [G1] } },
      deriveCollabSigningKey(JWT_SECRET), // correct key — only cnf is missing
      { algorithm: 'HS256', header: { alg: 'HS256', typ: COLLAB_TOKEN_TYP } },
    );
    expect(() => verifyCollabWriteToken(noCnf, JWT_SECRET)).toThrow();
  });

  it('a wrong typ header is rejected even with a valid signature', () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongTyp = jwt.sign(
      { iss: COLLAB_TOKEN_ISS, aud: COLLAB_TOKEN_AUD, sub: USER_ID, jti: 'x', iat: now, nbf: now, exp: now + 300,
        token_use: COLLAB_TOKEN_USE, collab: { v: 1, cid: CID, groupIds: [G1] }, cnf: { mcp_pub_b64: MCP_PUB_A } },
      deriveCollabSigningKey(JWT_SECRET),
      { algorithm: 'HS256', header: { alg: 'HS256', typ: 'mcp-s3+jwt' } }, // wrong typ
    );
    expect(() => verifyCollabWriteToken(wrongTyp, JWT_SECRET)).toThrow();
  });

  it('a tampered signature is rejected', () => {
    const { token } = mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: [G1], mcpPubB64: MCP_PUB_A });
    const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
    expect(() => verifyCollabWriteToken(tampered, JWT_SECRET)).toThrow();
  });
});

describe('mintCollabFromConnection — scope comes ONLY from the stored row (no widening)', () => {
  const conn = (groupIds: string[]) => ({ id: CID, user_id: USER_ID, mcp_pub_b64: MCP_PUB_A, scope: { collab: { groupIds } } });

  it('mints carrying EXACTLY the stored groupIds + binding', () => {
    const r = mintCollabFromConnection(conn([G1, G2]), JWT_SECRET)!;
    const v = verifyCollabWriteToken(r.token, JWT_SECRET);
    expect(v.collab.groupIds).toEqual([G1, G2]);
    expect(v.collab.cid).toBe(CID);
    expect(v.cnf.mcp_pub_b64).toBe(MCP_PUB_A);
  });

  it('returns null when the connection has NO collab authorization', () => {
    expect(mintCollabFromConnection({ id: CID, user_id: USER_ID, mcp_pub_b64: MCP_PUB_A, scope: {} }, JWT_SECRET)).toBeNull();
    expect(mintCollabFromConnection(conn([]), JWT_SECRET)).toBeNull();
  });

  it('CANNOT be widened by a smuggled top-level field on the conn object', () => {
    const tampered = { ...conn([G1]), groupIds: [G1, G2, G3] } as unknown as Parameters<typeof mintCollabFromConnection>[0];
    const r = mintCollabFromConnection(tampered, JWT_SECRET)!;
    const v = verifyCollabWriteToken(r.token, JWT_SECRET);
    expect(v.collab.groupIds).toEqual([G1]); // only the nested scope.collab.groupIds is read
  });
});

// ============================================================================
// 2. INTEGRATION — the HTTP routes (requires Postgres)
// ============================================================================

let pgAvailable = false;
try {
  const pool = createPostgresPool();
  const client = await pool.connect();
  client.release();
  pgAvailable = true;
} catch {
  console.warn('[test] PostgreSQL not available — skipping collab-write integration tests');
  await closePool();
}

const testConfig: AppConfig = {
  port: 3099,
  googleClientId: 'test-google-client-id',
  sessionSecret: 'test-session-secret-for-testing-only',
  jwtSecret: JWT_SECRET,
  nodeEnv: 'test',
  pinningServiceUrl: 'http://localhost:6000',
  mcpTokenTtlSeconds: 3600,
  systemKey: 'test-system-key-12345',
};

// Auth-boundary tests need NO database (rejected before any query() that matters).
describe('collab-write endpoints — auth boundary (no DB)', () => {
  let app: Express;
  beforeAll(() => {
    app = createApp(testConfig, { skipRateLimit: true }).app;
  });

  it('POST /api/mcp/connections/:id/collab-groups → 401 unauthenticated', async () => {
    const res = await request(app).post(`/api/mcp/connections/${CID}/collab-groups`).send({ groupIds: [G1] });
    expect(res.status).toBe(401);
  });
  it('DELETE /api/mcp/connections/:id/collab-groups → 401 unauthenticated', async () => {
    const res = await request(app).delete(`/api/mcp/connections/${CID}/collab-groups`).send({ groupIds: [G1] });
    expect(res.status).toBe(401);
  });
  it('POST /api/collab-groups/:groupId/ai-writes → 401 unauthenticated', async () => {
    const res = await request(app).post(`/api/collab-groups/${G1}/ai-writes`).send({ revoked: true });
    expect(res.status).toBe(401);
  });
  it('an mcp_s3 token is NOT accepted on a collab WRITE route (single accepted aud) → 401', async () => {
    const { token: mcpS3 } = mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: MCP_PUB_A });
    const res = await request(app)
      .put(`/api/collab/${G1}/manifest-sync`)
      .set('Authorization', `Bearer ${mcpS3}`)
      .send({ encryptedManifest: 'x' });
    expect(res.status).toBe(401);
  });

  it('a collab_write token is NOT accepted on the gateway/storage route → 401', async () => {
    const { token: collab } = mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: [G1], mcpPubB64: MCP_PUB_A });
    const res = await request(app).get('/api/v1/storage').set('Authorization', `Bearer ${collab}`);
    expect(res.status).toBe(401);
  });

  it('a collab_write token is NOT accepted on the DELETE route (AI may not delete) → 401', async () => {
    const { token: collab } = mintCollabWriteToken(USER_ID, JWT_SECRET, { connectionId: CID, groupIds: [G1], mcpPubB64: MCP_PUB_A });
    const res = await request(app).delete(`/api/collab/${G1}/file/${G2}`).set('Authorization', `Bearer ${collab}`);
    expect(res.status).toBe(401);
  });
});

describe.runIf(pgAvailable)('collab-write auth — endpoints', () => {
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
    await query('DELETE FROM collab_audit_log').catch(() => {});
    await query('DELETE FROM api_keys').catch(() => {});
  });

  const makeBearer = (userId: string) => createApiKey(userId, JWT_SECRET, generateJwtApiKey);

  // Pair an AI connection under `bearer`; returns { connectionId, refreshToken, mcpS3Token }.
  async function pair(bearer: string, pub = MCP_PUB_A) {
    const res = await request(app).post('/api/mcp/tokens').set('Authorization', `Bearer ${bearer}`).send({ mcp_pub_b64: pub });
    expect(res.status).toBe(200);
    return { connectionId: res.body.connectionId as string, refreshToken: res.body.refreshToken as string, mcpS3Token: res.body.token as string };
  }

  // Establish a real group with a creator (via a creator-authed manifest-sync).
  async function createGroup(groupId: string, creatorBearer: string) {
    const res = await request(app)
      .put(`/api/collab/${groupId}/manifest-sync`)
      .set('Authorization', `Bearer ${creatorBearer}`)
      .send({ encryptedManifest: 'seed' });
    expect(res.status).toBe(200);
  }

  // Authorize a connection for groups; returns the minted collab token.
  async function authorize(bearer: string, connectionId: string, groupIds: string[]) {
    const res = await request(app)
      .post(`/api/mcp/connections/${connectionId}/collab-groups`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ groupIds });
    return res;
  }

  it('a collab_write token writes ONLY to its authorized group (manifest-sync 200)', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer);
    const auth = await authorize(bearer, connectionId, [G1]);
    expect(auth.status).toBe(200);
    expect(auth.body.collabToken).toBeDefined();
    expect(auth.body.groupIds).toEqual([G1]);

    const w = await request(app)
      .put(`/api/collab/${G1}/manifest-sync`)
      .set('Authorization', `Bearer ${auth.body.collabToken}`)
      .send({ encryptedManifest: 'by-ai' });
    expect(w.status).toBe(200);
    expect(w.body.ok).toBe(true);
    expect(w.body.version).toBeGreaterThan(0);

    // creator_id preserved (AI never becomes creator).
    const row = await query('SELECT creator_id, encrypted_manifest FROM collab_manifests WHERE group_id = $1', [G1]);
    expect(row.rows[0].creator_id).toBe(USER_ID);
    expect(row.rows[0].encrypted_manifest).toBe('by-ai');
  });

  it('403 on a groupId the token is NOT authorized for', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer);
    const auth = await authorize(bearer, connectionId, [G1]);
    const w = await request(app)
      .put(`/api/collab/${G2}/manifest-sync`) // not authorized
      .set('Authorization', `Bearer ${auth.body.collabToken}`)
      .send({ encryptedManifest: 'x' });
    expect(w.status).toBe(403);
  });

  it('403 once the CONNECTION is revoked', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer);
    const auth = await authorize(bearer, connectionId, [G1]);
    await request(app).post(`/api/mcp/connections/${connectionId}/revoke`).set('Authorization', `Bearer ${bearer}`).send({});
    const w = await request(app)
      .put(`/api/collab/${G1}/manifest-sync`)
      .set('Authorization', `Bearer ${auth.body.collabToken}`)
      .send({ encryptedManifest: 'x' });
    expect(w.status).toBe(403);
  });

  it('403 once the GROUP is revoked (creator kill switch)', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer);
    const auth = await authorize(bearer, connectionId, [G1]);
    const kill = await request(app).post(`/api/collab-groups/${G1}/ai-writes`).set('Authorization', `Bearer ${bearer}`).send({ revoked: true });
    expect(kill.status).toBe(200);
    const w = await request(app)
      .put(`/api/collab/${G1}/manifest-sync`)
      .set('Authorization', `Bearer ${auth.body.collabToken}`)
      .send({ encryptedManifest: 'x' });
    expect(w.status).toBe(403);
  });

  it('403 IMMEDIATELY after a group is de-authorized on the connection (DB-truth, not token TTL)', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    await createGroup(G2, bearer);
    const { connectionId } = await pair(bearer);
    const auth = await authorize(bearer, connectionId, [G1, G2]);
    // token still claims [G1,G2]; remove G2 from the row.
    const del = await request(app)
      .delete(`/api/mcp/connections/${connectionId}/collab-groups`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ groupIds: [G2] });
    expect(del.status).toBe(200);
    expect(del.body.groupIds).toEqual([G1]);
    // G1 still works…
    const ok = await request(app).put(`/api/collab/${G1}/manifest-sync`).set('Authorization', `Bearer ${auth.body.collabToken}`).send({ encryptedManifest: 'x' });
    expect(ok.status).toBe(200);
    // …but G2 is denied immediately even though the (old) token still lists it.
    const denied = await request(app).put(`/api/collab/${G2}/manifest-sync`).set('Authorization', `Bearer ${auth.body.collabToken}`).send({ encryptedManifest: 'x' });
    expect(denied.status).toBe(403);
  });

  it('CROSS-PRODUCT: mcp_s3 token → 401 on collab; collab token → 401 on storage + DELETE', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId, mcpS3Token } = await pair(bearer);
    const auth = await authorize(bearer, connectionId, [G1]);
    const collabToken = auth.body.collabToken as string;

    // mcp_s3 token rejected on a collab WRITE route.
    const a = await request(app).put(`/api/collab/${G1}/manifest-sync`).set('Authorization', `Bearer ${mcpS3Token}`).send({ encryptedManifest: 'x' });
    expect(a.status).toBe(401);

    // collab token rejected on the gateway/storage route.
    const b = await request(app).get('/api/v1/storage').set('Authorization', `Bearer ${collabToken}`);
    expect(b.status).toBe(401);

    // collab token rejected on the DELETE route (AI may not delete).
    const c = await request(app).delete(`/api/collab/${G1}/file/${G2}`).set('Authorization', `Bearer ${collabToken}`);
    expect(c.status).toBe(401);
  });

  it('a widened request body CANNOT widen the token (scope from the row): refresh-connection ignores body', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId, refreshToken } = await pair(bearer);
    await authorize(bearer, connectionId, [G1]);
    const r = await request(app).post('/api/mcp/tokens/refresh-connection').send({
      refresh_token: refreshToken,
      groupIds: [G1, G2, G3], // attacker tries to widen via body
      collab: { groupIds: [G2] },
    });
    expect(r.status).toBe(200);
    expect(r.body.collabGroupIds).toEqual([G1]); // only the STORED [G1]
    const v = verifyCollabWriteToken(r.body.collabToken, JWT_SECRET);
    expect(v.collab.groupIds).toEqual([G1]);
  });

  it('authorize REJECTS unknown groups (404) and connections you do not own (404)', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer);
    // unknown group
    const unknown = await authorize(bearer, connectionId, [G3]);
    expect(unknown.status).toBe(404);
    // someone else's connection
    const attacker = await makeBearer(emailToUserId('attacker@example.com'));
    const notYours = await authorize(attacker, connectionId, [G1]);
    expect(notYours.status).toBe(404);
  });

  it('REGRESSION: the human session/api_key collab write path still works', async () => {
    const bearer = await makeBearer(USER_ID);
    const w = await request(app)
      .put(`/api/collab/${G1}/manifest-sync`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ encryptedManifest: 'human' });
    expect(w.status).toBe(200);
    expect(w.body.ok).toBe(true);
  });

  it('CAS: stale If-Match → 409; no If-Match → behaves as before', async () => {
    const bearer = await makeBearer(USER_ID);
    // v1 (no If-Match — legacy behaviour, still writes).
    const r1 = await request(app).put(`/api/collab/${G1}/manifest-sync`).set('Authorization', `Bearer ${bearer}`).send({ encryptedManifest: 'a' });
    expect(r1.status).toBe(200);
    const v1 = r1.body.version as number;
    // matching If-Match → 200, version moves to v2.
    const r2 = await request(app).put(`/api/collab/${G1}/manifest-sync`).set('Authorization', `Bearer ${bearer}`).set('If-Match', `"${v1}"`).send({ encryptedManifest: 'b' });
    expect(r2.status).toBe(200);
    expect(r2.body.version).toBe(v1 + 1);
    // stale If-Match (still v1, but stored is v2) → 409 with currentVersion.
    const r3 = await request(app).put(`/api/collab/${G1}/manifest-sync`).set('Authorization', `Bearer ${bearer}`).set('If-Match', `"${v1}"`).send({ encryptedManifest: 'c' });
    expect(r3.status).toBe(409);
    expect(r3.body.currentVersion).toBe(v1 + 1);
    // no If-Match → still writes (backward compatible).
    const r4 = await request(app).put(`/api/collab/${G1}/manifest-sync`).set('Authorization', `Bearer ${bearer}`).send({ encryptedManifest: 'd' });
    expect(r4.status).toBe(200);
  });

  it('writes an AUDIT row for an AI collab write (connection principal)', async () => {
    const bearer = await makeBearer(USER_ID);
    await createGroup(G1, bearer);
    const { connectionId } = await pair(bearer);
    const auth = await authorize(bearer, connectionId, [G1]);
    await request(app).put(`/api/collab/${G1}/manifest-sync`).set('Authorization', `Bearer ${auth.body.collabToken}`).send({ encryptedManifest: 'x' });

    // The audit row is inserted fire-and-forget on res 'finish' (so it never
    // blocks the response) — poll until it lands.
    await vi.waitFor(async () => {
      const audit = await query(
        `SELECT principal_id, principal_type, group_id, verb FROM collab_audit_log
          WHERE group_id = $1 AND principal_type = 'connection' ORDER BY id DESC LIMIT 1`,
        [G1],
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].principal_id).toBe(connectionId);
      expect(audit.rows[0].verb).toBe('manifest-sync');
    }, { timeout: 3000, interval: 50 });
  });

  it('the kill switch is CREATOR-GATED (a non-creator cannot revoke a group)', async () => {
    const creator = await makeBearer(USER_ID);
    await createGroup(G1, creator);
    const attacker = await makeBearer(emailToUserId('attacker2@example.com'));
    const res = await request(app).post(`/api/collab-groups/${G1}/ai-writes`).set('Authorization', `Bearer ${attacker}`).send({ revoked: true });
    expect(res.status).toBe(403);
  });
});
