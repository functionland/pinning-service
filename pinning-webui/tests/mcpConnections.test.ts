/**
 * MCP connection lifecycle tests — registry + scoped refresh + revocation.
 *
 * Two layers (same convention as mcpTokens.test.ts):
 *  1. PURE-LOGIC (always run, no DB) — these PIN THE SECURITY INVARIANT: a
 *     refresh re-mints ONLY the connection's STORED scope; a tampered/widened
 *     request body cannot widen the issued token. Plus: a refresh token is
 *     high-entropy, only its sha256 hash is persisted, and the response shape.
 *  2. INTEGRATION (describe.runIf(pgAvailable)) — the endpoints over HTTP:
 *     mint→connection row + refreshToken; refresh-by-token → fresh workspace
 *     JWT; refresh after revoke → 401; the revoked feed; and that GET
 *     /api/mcp/connections never leaks the refresh token. Skipped without pg.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp, generateJwtApiKey, type AppConfig } from '../server/app.js';
import { createPostgresPool, closePool, query, createApiKey } from '../server/database/postgres.js';
import { emailToUserId } from '../server/utils/hash.js';
import {
  verifyMcpToken,
  getCnfMcpPubB64,
  MCP_WORKSPACE_BUCKET,
  MCP_WORKSPACE_PREFIX,
} from '../server/mcpTokens.js';
import {
  newRefreshToken,
  hashRefreshToken,
  mintFromConnection,
  MCP_REFRESH_TOKEN_BYTES,
  type StoredConnectionScope,
} from '../server/mcpConnections.js';
import crypto from 'crypto';

const JWT_SECRET = 'test-jwt-secret-for-testing-only';
const USER_ID = emailToUserId('mcp-conn-test@example.com');
// Real 32-byte X25519-shaped pubkeys, standard-base64 (FxFiles convention).
const MCP_PUB_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const MCP_PUB_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64');

// Build a stored-connection scope row with the given perms (the frozen claim).
function storedConn(perms: string[], pub = MCP_PUB_A, bucket = MCP_WORKSPACE_BUCKET): StoredConnectionScope {
  return {
    user_id: USER_ID,
    mcp_pub_b64: pub,
    scope: { v: 1, scopes: [{ bucket, prefix: MCP_WORKSPACE_PREFIX, perms }] },
  };
}

// ============================================================================
// 1. PURE-LOGIC — the refresh-token primitive + the scoping invariant
// ============================================================================

describe('newRefreshToken / hashRefreshToken — high-entropy secret, hash-only storage', () => {
  it('generates a 256-bit (32-byte) base64url token and its sha256 hex hash', () => {
    const { token, hash } = newRefreshToken();
    // base64url of 32 bytes decodes back to exactly 32 bytes.
    expect(Buffer.from(token, 'base64url').length).toBe(MCP_REFRESH_TOKEN_BYTES);
    // hash is the sha256 hex of the token (64 hex chars), and matches hashRefreshToken.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashRefreshToken(token));
    // The hash is NOT the token (we store only the hash).
    expect(hash).not.toBe(token);
  });

  it('hashRefreshToken is a stable, correct sha256-hex of its input', () => {
    const t = 'some-refresh-token';
    const expected = crypto.createHash('sha256').update(t, 'utf8').digest('hex');
    expect(hashRefreshToken(t)).toBe(expected);
  });

  it('two fresh tokens differ (unguessable, unique)', () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('mintFromConnection — re-mint PINNED to the STORED scope (the invariant)', () => {
  it('mints a token carrying EXACTLY the stored perms (narrow stays narrow)', () => {
    const { token } = mintFromConnection(storedConn(['read']), JWT_SECRET);
    const claims = verifyMcpToken(token, JWT_SECRET, { expectedSub: USER_ID });
    // The minted scope is the STORED ['read'], NOT the all-perms default.
    expect(claims.mcp.scopes[0].perms).toEqual(['read']);
    expect(claims.mcp.scopes[0].bucket).toBe(MCP_WORKSPACE_BUCKET);
    expect(claims.mcp.scopes[0].prefix).toBe(MCP_WORKSPACE_PREFIX);
    // And it stays bound to the connection (cnf re-applied).
    expect(getCnfMcpPubB64(claims)).toBe(MCP_PUB_A);
  });

  it('preserves a read+write+list stored scope verbatim', () => {
    const { token } = mintFromConnection(storedConn(['read', 'write', 'list']), JWT_SECRET);
    const claims = verifyMcpToken(token, JWT_SECRET);
    expect(claims.mcp.scopes[0].perms).toEqual(['read', 'write', 'list']);
  });

  it('each re-mint gets a fresh unique jti', () => {
    const a = mintFromConnection(storedConn(['read']), JWT_SECRET);
    const b = mintFromConnection(storedConn(['read']), JWT_SECRET);
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it('honours an explicit jti (for deterministic tests)', () => {
    const { claims } = mintFromConnection(storedConn(['read']), JWT_SECRET, 'fixed-jti');
    expect(claims.jti).toBe('fixed-jti');
  });

  // ── THE widening guard ───────────────────────────────────────────────────
  it('CANNOT be widened: extra/forged fields on the conn object never widen perms', () => {
    // Simulate an attacker-influenced row that tries to smuggle a top-level
    // perms/bucket (as a naive `{...conn.scope}` spread would surface). The
    // function reads ONLY scopes[0].perms, so the smuggled widening is ignored.
    const tampered = {
      ...storedConn(['read']),
      // These keys do not exist on the real type, but mimic a body-spread attack.
      perms: ['read', 'write', 'list'],
      bucket: 'some-other-bucket',
    } as unknown as StoredConnectionScope;
    const { token } = mintFromConnection(tampered, JWT_SECRET);
    const claims = verifyMcpToken(token, JWT_SECRET);
    // Still ['read'] — the smuggled all-perms is ignored.
    expect(claims.mcp.scopes[0].perms).toEqual(['read']);
    expect(claims.mcp.scopes[0].bucket).toBe(MCP_WORKSPACE_BUCKET);
  });

  it('FAILS CLOSED on a malformed stored scope: no perms (NOT the all-perms default)', () => {
    // A row whose scopes[0] is missing/empty must yield an EMPTY perms set —
    // never silently widen to ['read','write','list'] via mint's default.
    const malformed = {
      user_id: USER_ID,
      mcp_pub_b64: MCP_PUB_A,
      scope: { v: 1, scopes: [] },
    } as unknown as StoredConnectionScope;
    const { token } = mintFromConnection(malformed, JWT_SECRET);
    const claims = verifyMcpToken(token, JWT_SECRET);
    expect(claims.mcp.scopes[0].perms).toEqual([]); // fail-closed: zero perms
  });

  it('binds to the connection pubkey from the row, not any request input', () => {
    const { token } = mintFromConnection(storedConn(['read'], MCP_PUB_B), JWT_SECRET);
    const claims = verifyMcpToken(token, JWT_SECRET);
    expect(getCnfMcpPubB64(claims)).toBe(MCP_PUB_B);
  });
});

// ============================================================================
// 2. INTEGRATION — the endpoints over HTTP (requires Postgres)
// ============================================================================

let pgAvailable = false;
try {
  const pool = createPostgresPool();
  const client = await pool.connect();
  client.release();
  pgAvailable = true;
} catch {
  console.warn('[test] PostgreSQL not available — skipping MCP connection integration tests');
  await closePool();
}

const testConfig: AppConfig = {
  port: 3098,
  googleClientId: 'test-google-client-id',
  sessionSecret: 'test-session-secret-for-testing-only',
  jwtSecret: JWT_SECRET,
  nodeEnv: 'test',
  pinningServiceUrl: 'http://localhost:6000',
  mcpTokenTtlSeconds: 3600,
  systemKey: 'test-system-key-12345',
};

// Auth-boundary tests need NO database (rejected before any query()).
describe('MCP connection endpoints — auth boundary (no DB)', () => {
  let app: Express;
  beforeAll(() => {
    app = createApp(testConfig, { skipRateLimit: true }).app;
  });

  it('GET /api/mcp/connections → 401 unauthenticated', async () => {
    const res = await request(app).get('/api/mcp/connections');
    expect(res.status).toBe(401);
  });
  it('POST /api/mcp/connections/:id/revoke → 401 unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/connections/abc/revoke').send({});
    expect(res.status).toBe(401);
  });
  it('GET /api/mcp/connections/revoked → 401 without system key / admin', async () => {
    const res = await request(app).get('/api/mcp/connections/revoked');
    expect(res.status).toBe(401);
  });
  it('POST /api/mcp/tokens/refresh-connection → 400 without refresh_token (NOT 401 — it is unauthenticated)', async () => {
    // The endpoint is deliberately unauthenticated (the refresh token is the
    // credential). A missing token is a 400, validated before any DB access —
    // so this runs green without Postgres. (The unknown-token → 401 case needs a
    // DB lookup and is asserted in the pg-gated block.)
    const res = await request(app).post('/api/mcp/tokens/refresh-connection').send({});
    expect(res.status).toBe(400);
  });
});

describe.runIf(pgAvailable)('MCP connection lifecycle — endpoints', () => {
  let app: Express;

  beforeAll(async () => {
    app = createApp(testConfig, { skipRateLimit: true }).app;
    const { createMcpConnectionsTable } = await import('../server/database/postgres.js');
    const { createMcpRevocationTable } = await import('../server/database/postgres.js');
    await createMcpConnectionsTable();
    await createMcpRevocationTable();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await query('DELETE FROM mcp_connections').catch(() => {});
    await query('DELETE FROM mcp_revoked_tokens').catch(() => {});
    await query('DELETE FROM api_keys').catch(() => {});
  });

  async function makeBearer(userId: string): Promise<string> {
    return createApiKey(userId, JWT_SECRET, generateJwtApiKey);
  }

  // Mint a BOUND token (registers a connection + returns refreshToken).
  async function mintBound(bearer: string, pub = MCP_PUB_A, body: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/mcp/tokens')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: pub, ...body });
  }

  it('mint with mcp_pub_b64 registers a connection row AND returns a refreshToken', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await mintBound(bearer, MCP_PUB_A, { label: 'my laptop' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.connectionId).toBeDefined();

    // A row exists, storing ONLY the hash of the returned refresh token.
    const row = await query(
      'SELECT user_id, mcp_pub_b64, label, refresh_token_hash, scope, revoked FROM mcp_connections WHERE id = $1',
      [res.body.connectionId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].user_id).toBe(USER_ID);
    expect(row.rows[0].mcp_pub_b64).toBe(MCP_PUB_A);
    expect(row.rows[0].label).toBe('my laptop');
    expect(row.rows[0].revoked).toBe(false);
    // The stored hash == sha256(returned token); the plaintext is NOT stored.
    expect(row.rows[0].refresh_token_hash).toBe(hashRefreshToken(res.body.refreshToken));
    expect(row.rows[0].refresh_token_hash).not.toBe(res.body.refreshToken);
    // The frozen scope is the resolved claim.
    expect(row.rows[0].scope.scopes[0].prefix).toBe(MCP_WORKSPACE_PREFIX);
  });

  it('mint WITHOUT mcp_pub_b64 does NOT register a connection and returns NO refreshToken (backward-compat)', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await request(app).post('/api/mcp/tokens').set('Authorization', `Bearer ${bearer}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.connectionId).toBeUndefined();
    const count = await query('SELECT COUNT(*)::int AS n FROM mcp_connections');
    expect(count.rows[0].n).toBe(0);
  });

  it('legacy POST /api/mcp/tokens/refresh does NOT create a connection even WITH a pubkey', async () => {
    const bearer = await makeBearer(USER_ID);
    // Hit the legacy session/bearer refresh route with a pubkey present.
    const res = await request(app)
      .post('/api/mcp/tokens/refresh')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined(); // never issued here
    const count = await query('SELECT COUNT(*)::int AS n FROM mcp_connections');
    expect(count.rows[0].n).toBe(0); // and no row spawned
  });

  it('refresh-connection mints a fresh, valid WORKSPACE-scoped JWT (bucket+prefix asserted)', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await mintBound(bearer, MCP_PUB_A);
    const refreshToken = minted.body.refreshToken;

    const res = await request(app)
      .post('/api/mcp/tokens/refresh-connection')
      .send({ refresh_token: refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.jti).toBeDefined();
    expect(res.body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The minted token is a real workspace-scoped, connection-bound JWT.
    const claims = verifyMcpToken(res.body.token, JWT_SECRET, { expectedSub: USER_ID });
    expect(claims.mcp.scopes[0].bucket).toBe(MCP_WORKSPACE_BUCKET);
    expect(claims.mcp.scopes[0].prefix).toBe(MCP_WORKSPACE_PREFIX);
    expect(getCnfMcpPubB64(claims)).toBe(MCP_PUB_A);
    // A different jti from the original mint.
    expect(res.body.jti).not.toBe(minted.body.jti);
  });

  it('refresh-connection re-mints the STORED scope — a widened body CANNOT widen it', async () => {
    // Pair with NARROW perms (read-only) by passing ttl only; the stored scope
    // comes from the resolved claim. To force a narrow stored scope we mint with
    // a pubkey and then patch the row's scope to ['read'] (simulating a
    // read-only pairing), then attempt a refresh with a widened body.
    const bearer = await makeBearer(USER_ID);
    const minted = await mintBound(bearer, MCP_PUB_A);
    await query(
      `UPDATE mcp_connections SET scope = $1 WHERE id = $2`,
      [JSON.stringify({ v: 1, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: MCP_WORKSPACE_PREFIX, perms: ['read'] }] }), minted.body.connectionId],
    );

    // Attempt to widen via the body — extra fields must be ignored.
    const res = await request(app)
      .post('/api/mcp/tokens/refresh-connection')
      .send({
        refresh_token: minted.body.refreshToken,
        perms: ['read', 'write', 'list'],
        mcp: { v: 1, scopes: [{ bucket: 'evil', prefix: 'ai/', perms: ['read', 'write', 'list'] }] },
        bucket: 'evil-bucket',
        ttlSeconds: 999999,
      });
    expect(res.status).toBe(200);
    const claims = verifyMcpToken(res.body.token, JWT_SECRET);
    // Scope is the STORED ['read'] — NOT widened by the body.
    expect(claims.mcp.scopes[0].perms).toEqual(['read']);
    expect(claims.mcp.scopes[0].bucket).toBe(MCP_WORKSPACE_BUCKET);
    expect(claims.mcp.scopes[0].prefix).toBe(MCP_WORKSPACE_PREFIX);
  });

  it('refresh-connection AFTER revoke → 401', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await mintBound(bearer, MCP_PUB_A);

    // User revokes the connection.
    const rev = await request(app)
      .post(`/api/mcp/connections/${minted.body.connectionId}/revoke`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({});
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(true);

    // The refresh token is now dead.
    const res = await request(app)
      .post('/api/mcp/tokens/refresh-connection')
      .send({ refresh_token: minted.body.refreshToken });
    expect(res.status).toBe(401);
  });

  it('refresh-connection with an unknown token → 401', async () => {
    const res = await request(app)
      .post('/api/mcp/tokens/refresh-connection')
      .send({ refresh_token: newRefreshToken().token }); // valid shape, not in DB
    expect(res.status).toBe(401);
  });

  it('refresh-connection bumps last_refreshed_at', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await mintBound(bearer, MCP_PUB_A);
    const before = await query('SELECT last_refreshed_at FROM mcp_connections WHERE id = $1', [minted.body.connectionId]);
    expect(before.rows[0].last_refreshed_at).toBeNull();

    await request(app).post('/api/mcp/tokens/refresh-connection').send({ refresh_token: minted.body.refreshToken });

    const after = await query('SELECT last_refreshed_at FROM mcp_connections WHERE id = $1', [minted.body.connectionId]);
    expect(after.rows[0].last_refreshed_at).not.toBeNull();
  });

  it('GET /api/mcp/connections lists the user\'s connections and NEVER leaks the refresh token/hash', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await mintBound(bearer, MCP_PUB_A, { label: 'laptop' });

    const res = await request(app).get('/api/mcp/connections').set('Authorization', `Bearer ${bearer}`);
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(1);
    const conn = res.body.connections[0];
    expect(conn.id).toBe(minted.body.connectionId);
    expect(conn.label).toBe('laptop');
    expect(conn.mcp_pub_b64).toBe(MCP_PUB_A);
    expect(conn.revoked).toBe(false);
    expect('created_at' in conn).toBe(true);
    expect('last_refreshed_at' in conn).toBe(true);
    // THE leak guard: no refresh token / hash in the payload.
    expect('refresh_token' in conn).toBe(false);
    expect('refresh_token_hash' in conn).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(minted.body.refreshToken);
    expect(JSON.stringify(res.body)).not.toContain(hashRefreshToken(minted.body.refreshToken));
  });

  it('a user cannot revoke ANOTHER user\'s connection (user-scoped)', async () => {
    const victimBearer = await makeBearer(USER_ID);
    const minted = await mintBound(victimBearer, MCP_PUB_A);

    const attackerId = emailToUserId('attacker@example.com');
    const attackerBearer = await makeBearer(attackerId);
    const rev = await request(app)
      .post(`/api/mcp/connections/${minted.body.connectionId}/revoke`)
      .set('Authorization', `Bearer ${attackerBearer}`)
      .send({});
    // The revoke matches 0 of the victim's rows → alreadyRevoked semantics.
    expect(rev.status).toBe(200);
    expect(rev.body.alreadyRevoked).toBe(true);

    // Victim's connection is still live: refresh still works.
    const ok = await request(app).post('/api/mcp/tokens/refresh-connection').send({ refresh_token: minted.body.refreshToken });
    expect(ok.status).toBe(200);
  });

  it('the gateway revoked feed lists a revoked connection\'s pubkey (system key)', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await mintBound(bearer, MCP_PUB_A);

    // Before revoke: feed is empty.
    const empty = await request(app).get('/api/mcp/connections/revoked').set('x-system-key', testConfig.systemKey!);
    expect(empty.status).toBe(200);
    expect(empty.body.revoked_pubkeys).not.toContain(MCP_PUB_A);

    // Revoke, then the feed lists the pubkey.
    await request(app).post(`/api/mcp/connections/${minted.body.connectionId}/revoke`).set('Authorization', `Bearer ${bearer}`).send({});
    const after = await request(app).get('/api/mcp/connections/revoked').set('x-system-key', testConfig.systemKey!);
    expect(after.status).toBe(200);
    expect(after.body.revoked_pubkeys).toContain(MCP_PUB_A);
  });

  it('the revoked feed requires the system key / admin (plain bearer rejected)', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await request(app).get('/api/mcp/connections/revoked').set('Authorization', `Bearer ${bearer}`);
    expect(res.status).toBe(401);
  });
});
