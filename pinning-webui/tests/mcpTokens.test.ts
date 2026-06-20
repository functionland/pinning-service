/**
 * Phase 11 — Scoped MCP-JWT issuer tests.
 *
 * Two layers:
 *  1. PURE-LOGIC tests (always run, no DB) — these PIN THE P12 CONTRACT: the
 *     exact scope-claim shape, mint/verify round-trip, TTL clamping, the
 *     token-confusion guard (a broad storage JWT must NOT pass as an MCP
 *     token), and the prefix/sub isolation invariant.
 *  2. INTEGRATION tests (describe.runIf(pgAvailable)) — the actual endpoints
 *     (mint / refresh / revoke / revocations) over HTTP, authenticated with a
 *     Bearer API-key. Skipped automatically when Postgres isn't reachable
 *     (same convention as api.test.ts / seedAuth.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import { createApp, generateJwtApiKey, type AppConfig } from '../server/app.js';
import { createPostgresPool, closePool, query, createApiKey } from '../server/database/postgres.js';
import { emailToUserId } from '../server/utils/hash.js';
import {
  mintMcpToken,
  verifyMcpToken,
  resolveRevocationTarget,
  resolveMcpTtlSeconds,
  decodeMcpJtiExp,
  decodeJwtHeader,
  buildMcpScopeClaim,
  MCP_TOKEN_TYP,
  MCP_TOKEN_USE,
  MCP_TOKEN_ISS,
  MCP_TOKEN_AUD,
  MCP_SCOPE_VERSION,
  MCP_WORKSPACE_BUCKET,
  MCP_TOKEN_TTL_DEFAULT_SECONDS,
  MCP_TOKEN_TTL_MIN_SECONDS,
  MCP_TOKEN_TTL_MAX_SECONDS,
} from '../server/mcpTokens.js';

const JWT_SECRET = 'test-jwt-secret-for-testing-only';
// A 64-hex user_id, the real shape (SHA-256 of an email).
const USER_ID = emailToUserId('mcp-test@example.com');

// ============================================================================
// 1. PURE-LOGIC — the P12 contract (always runs, no database)
// ============================================================================

describe('MCP scope claim — the P12 contract', () => {
  it('buildMcpScopeClaim derives prefix from userId and defaults to all perms', () => {
    const claim = buildMcpScopeClaim(USER_ID);
    expect(claim.v).toBe(MCP_SCOPE_VERSION);
    expect(claim.scopes).toHaveLength(1);
    expect(claim.scopes[0].bucket).toBe(MCP_WORKSPACE_BUCKET);
    expect(claim.scopes[0].prefix).toBe(`${USER_ID}/`);
    expect(claim.scopes[0].perms).toEqual(['read', 'write', 'list']);
  });

  it('mintMcpToken produces a token that verifies and carries the SCOPED claim (not storage:*)', () => {
    const { token, claims } = mintMcpToken(USER_ID, JWT_SECRET);

    // Header carries the explicit media type.
    const header = decodeJwtHeader(token);
    expect(header?.alg).toBe('HS256');
    expect(header?.typ).toBe(MCP_TOKEN_TYP);

    // Verifies under JWT_SECRET (plain jwt.verify — independent of our helper).
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.sub).toBe(USER_ID);
    expect(decoded.iss).toBe(MCP_TOKEN_ISS);
    expect(decoded.aud).toBe(MCP_TOKEN_AUD);
    expect(decoded.token_use).toBe(MCP_TOKEN_USE);
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.jti.length).toBeGreaterThan(10);

    // exp is near-future (default 1h), nbf/iat set.
    const now = Math.floor(Date.now() / 1000);
    expect(decoded.exp).toBeGreaterThan(now);
    expect(decoded.exp).toBeLessThanOrEqual(now + MCP_TOKEN_TTL_DEFAULT_SECONDS + 5);
    expect(decoded.nbf).toBeLessThanOrEqual(now + 1);

    // The contract: structured `mcp` claim, NOT the broad storage scope string.
    expect(decoded.scope).toBeUndefined();
    expect(decoded.mcp).toBeDefined();
    expect(decoded.mcp.v).toBe(1);
    expect(decoded.mcp.scopes[0]).toEqual({
      bucket: MCP_WORKSPACE_BUCKET,
      prefix: `${USER_ID}/`,
      perms: ['read', 'write', 'list'],
    });

    // claims returned to caller match what's signed.
    expect(claims.jti).toBe(decoded.jti);
    expect(claims.exp).toBe(decoded.exp);
  });

  it('verifyMcpToken accepts a freshly minted token and returns its claims', () => {
    const { token } = mintMcpToken(USER_ID, JWT_SECRET);
    const claims = verifyMcpToken(token, JWT_SECRET, { expectedSub: USER_ID });
    expect(claims.sub).toBe(USER_ID);
    expect(claims.mcp.scopes[0].prefix).toBe(`${USER_ID}/`);
  });

  it('verifyMcpToken REJECTS a broad storage JWT (token-confusion guard)', () => {
    // The existing long-lived API-key JWT: scope:"storage:read storage:write",
    // no exp, no typ, no token_use, no mcp. Must NOT be honoured as MCP.
    const storageToken = generateJwtApiKey(USER_ID, JWT_SECRET);
    expect(() => verifyMcpToken(storageToken, JWT_SECRET)).toThrow();
  });

  it('verifyMcpToken REJECTS a token signed with the wrong secret', () => {
    const { token } = mintMcpToken(USER_ID, JWT_SECRET);
    expect(() => verifyMcpToken(token, 'a-different-secret')).toThrow();
  });

  it('verifyMcpToken REJECTS an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const { token } = mintMcpToken(USER_ID, JWT_SECRET, { nowSeconds: past, ttlSeconds: 60 });
    // expired well beyond the 120s clock tolerance
    expect(() => verifyMcpToken(token, JWT_SECRET)).toThrow();
  });

  it('verifyMcpToken REJECTS a token whose embedded prefix does not match sub (cross-user)', () => {
    // Hand-craft a token where the prefix belongs to a DIFFERENT user — the
    // exact attack the prefix-binding defends against.
    const otherUser = emailToUserId('victim@example.com');
    const now = Math.floor(Date.now() / 1000);
    const forged = jwt.sign(
      {
        iss: MCP_TOKEN_ISS,
        aud: MCP_TOKEN_AUD,
        sub: USER_ID,
        jti: 'forged',
        iat: now,
        nbf: now,
        exp: now + 600,
        token_use: MCP_TOKEN_USE,
        mcp: { v: 1, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: `${otherUser}/`, perms: ['read'] }] },
      },
      JWT_SECRET,
      { algorithm: 'HS256', header: { alg: 'HS256', typ: MCP_TOKEN_TYP } },
    );
    expect(() => verifyMcpToken(forged, JWT_SECRET)).toThrow(/prefix/);
  });

  it('verifyMcpToken REJECTS an unknown mcp.v (forward-compat: pinned gateway rejects v2)', () => {
    const now = Math.floor(Date.now() / 1000);
    const v2 = jwt.sign(
      {
        iss: MCP_TOKEN_ISS, aud: MCP_TOKEN_AUD, sub: USER_ID, jti: 'x',
        iat: now, nbf: now, exp: now + 600, token_use: MCP_TOKEN_USE,
        mcp: { v: 2, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: `${USER_ID}/`, perms: ['read'] }] },
      },
      JWT_SECRET,
      { algorithm: 'HS256', header: { alg: 'HS256', typ: MCP_TOKEN_TYP } },
    );
    expect(() => verifyMcpToken(v2, JWT_SECRET)).toThrow(/mcp\.v/);
  });

  it('verifyMcpToken enforces a max TTL even with a valid signature', () => {
    const now = Math.floor(Date.now() / 1000);
    // mintMcpToken clamps to 24h, so craft an over-long token manually.
    const tooLong = jwt.sign(
      {
        iss: MCP_TOKEN_ISS, aud: MCP_TOKEN_AUD, sub: USER_ID, jti: 'x',
        iat: now, nbf: now, exp: now + 48 * 3600, token_use: MCP_TOKEN_USE,
        mcp: { v: 1, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: `${USER_ID}/`, perms: ['read'] }] },
      },
      JWT_SECRET,
      { algorithm: 'HS256', header: { alg: 'HS256', typ: MCP_TOKEN_TYP } },
    );
    expect(() => verifyMcpToken(tooLong, JWT_SECRET, { maxTtlSeconds: 24 * 3600 })).toThrow(/ttl/);
  });

  it('resolveMcpTtlSeconds clamps to [min, max] and defaults sanely', () => {
    expect(resolveMcpTtlSeconds(undefined)).toBe(MCP_TOKEN_TTL_DEFAULT_SECONDS);
    expect(resolveMcpTtlSeconds(NaN)).toBe(MCP_TOKEN_TTL_DEFAULT_SECONDS);
    expect(resolveMcpTtlSeconds(1)).toBe(MCP_TOKEN_TTL_MIN_SECONDS);
    expect(resolveMcpTtlSeconds(999_999)).toBe(MCP_TOKEN_TTL_MAX_SECONDS);
    expect(resolveMcpTtlSeconds(1800)).toBe(1800);
  });

  it('decodeMcpJtiExp extracts jti + exp without verifying, and is null-safe', () => {
    const { token, claims } = mintMcpToken(USER_ID, JWT_SECRET);
    const d = decodeMcpJtiExp(token);
    expect(d.jti).toBe(claims.jti);
    expect(d.exp).toBe(claims.exp);
    expect(decodeMcpJtiExp('garbage')).toEqual({ jti: null, exp: null });
  });

  it('each mint gets a fresh unique jti', () => {
    const a = mintMcpToken(USER_ID, JWT_SECRET);
    const b = mintMcpToken(USER_ID, JWT_SECRET);
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });
});

describe('resolveRevocationTarget — revocation access control (security-critical)', () => {
  it('returns the jti+exp for the caller\'s OWN valid token', () => {
    const { token, claims } = mintMcpToken(USER_ID, JWT_SECRET);
    const r = resolveRevocationTarget(token, JWT_SECRET, USER_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jti).toBe(claims.jti);
      expect(r.exp).toBe(claims.exp);
      expect(r.userId).toBe(USER_ID);
    }
  });

  it('REJECTS (403) a token belonging to a DIFFERENT user', () => {
    const victimToken = mintMcpToken(USER_ID, JWT_SECRET).token;
    const attackerId = emailToUserId('attacker@example.com');
    const r = resolveRevocationTarget(victimToken, JWT_SECRET, attackerId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('REJECTS (400) the swapped-jti attack: own token, payload edited to a victim jti', () => {
    // Attacker holds a valid token, edits its payload to insert a victim's jti.
    // Editing the payload breaks the HS256 signature → verification fails → 400.
    const attackerId = emailToUserId('attacker@example.com');
    const { token } = mintMcpToken(attackerId, JWT_SECRET);
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    payload.jti = 'victims-jti-to-revoke';
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    const r = resolveRevocationTarget(tampered, JWT_SECRET, attackerId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('REJECTS (400) an expired token (already dead by exp — no revocation needed)', () => {
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const { token } = mintMcpToken(USER_ID, JWT_SECRET, { nowSeconds: past, ttlSeconds: 60 });
    const r = resolveRevocationTarget(token, JWT_SECRET, USER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('REJECTS (400) garbage / non-MCP input', () => {
    const r = resolveRevocationTarget('not.a.jwt', JWT_SECRET, USER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
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
  console.warn('[test] PostgreSQL not available — skipping MCP endpoint integration tests');
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
};

describe.runIf(pgAvailable)('MCP token endpoints', () => {
  let app: Express;

  beforeAll(async () => {
    const result = createApp(testConfig, { skipRateLimit: true });
    app = result.app;
    // Ensure the revocation table exists (initializeDatabase isn't called by
    // createApp; create it directly — idempotent CREATE TABLE IF NOT EXISTS).
    const { createMcpRevocationTable } = await import('../server/database/postgres.js');
    await createMcpRevocationTable();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await query('DELETE FROM mcp_revoked_tokens').catch(() => {});
    await query('DELETE FROM api_keys').catch(() => {});
  });

  // Create a real Bearer API-key for USER_ID and return the raw token.
  async function makeBearer(userId: string): Promise<string> {
    return createApiKey(userId, JWT_SECRET, generateJwtApiKey);
  }

  it('POST /api/mcp/tokens → 401 when unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/tokens').send({});
    expect(res.status).toBe(401);
  });

  it('POST /api/mcp/tokens (Bearer) mints a scoped token for the user', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await request(app)
      .post('/api/mcp/tokens')
      .set('Authorization', `Bearer ${bearer}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.jti).toBeDefined();
    expect(res.body.tokenType).toBe(MCP_TOKEN_USE);
    expect(res.body.scope.v).toBe(1);
    expect(res.body.scope.scopes[0].prefix).toBe(`${USER_ID}/`);

    // The returned token is a real, verifiable MCP token bound to the user.
    const claims = verifyMcpToken(res.body.token, JWT_SECRET, { expectedSub: USER_ID });
    expect(claims.sub).toBe(USER_ID);
    expect(claims.mcp.scopes[0].perms).toEqual(['read', 'write', 'list']);
    // NOT the broad storage scope.
    expect((claims as any).scope).toBeUndefined();
  });

  it('POST /api/mcp/tokens honours a downward ttl override (clamped)', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await request(app)
      .post('/api/mcp/tokens')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ ttlSeconds: 120 });
    expect(res.status).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    expect(res.body.expiresAt).toBeLessThanOrEqual(now + 120 + 5);
    expect(res.body.expiresAt).toBeGreaterThan(now);
  });

  it('POST /api/mcp/tokens/refresh issues a NEW token (different jti)', async () => {
    const bearer = await makeBearer(USER_ID);
    const first = await request(app).post('/api/mcp/tokens').set('Authorization', `Bearer ${bearer}`).send({});
    const refreshed = await request(app).post('/api/mcp/tokens/refresh').set('Authorization', `Bearer ${bearer}`).send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.jti).toBeDefined();
    expect(refreshed.body.jti).not.toBe(first.body.jti);
    // Both verify independently.
    expect(() => verifyMcpToken(refreshed.body.token, JWT_SECRET, { expectedSub: USER_ID })).not.toThrow();
  });

  it('POST /api/mcp/tokens/revoke adds the jti and the revocations lookup reports it', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await request(app).post('/api/mcp/tokens').set('Authorization', `Bearer ${bearer}`).send({});
    const token = minted.body.token;
    const jti = minted.body.jti;

    const revoke = await request(app)
      .post('/api/mcp/tokens/revoke')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ token });
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBe(true);
    expect(revoke.body.jti).toBe(jti);

    // The gateway lookup (system key) now lists this jti.
    const list = await request(app)
      .get('/api/mcp/tokens/revocations')
      .set('x-system-key', testConfig.systemKey!);
    expect(list.status).toBe(200);
    expect(list.body.revoked).toContain(jti);

    // And the point-check returns revoked=true.
    const probe = await request(app)
      .get(`/api/mcp/tokens/revocations?jti=${jti}`)
      .set('x-system-key', testConfig.systemKey!);
    expect(probe.status).toBe(200);
    expect(probe.body.revoked).toBe(true);
  });

  it('revoke is idempotent (second revoke → alreadyRevoked)', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await request(app).post('/api/mcp/tokens').set('Authorization', `Bearer ${bearer}`).send({});
    const token = minted.body.token;
    await request(app).post('/api/mcp/tokens/revoke').set('Authorization', `Bearer ${bearer}`).send({ token });
    const again = await request(app).post('/api/mcp/tokens/revoke').set('Authorization', `Bearer ${bearer}`).send({ token });
    expect(again.status).toBe(200);
    expect(again.body.alreadyRevoked).toBe(true);
  });

  it('a user cannot revoke ANOTHER user\'s token', async () => {
    const attackerId = emailToUserId('attacker@example.com');
    const attackerBearer = await makeBearer(attackerId);
    // Mint a token for the VICTIM (USER_ID) directly.
    const victimToken = mintMcpToken(USER_ID, JWT_SECRET).token;

    const res = await request(app)
      .post('/api/mcp/tokens/revoke')
      .set('Authorization', `Bearer ${attackerBearer}`)
      .send({ token: victimToken });
    expect(res.status).toBe(403);
  });

  it('GET /api/mcp/tokens/revocations requires system key / admin (plain bearer rejected)', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await request(app)
      .get('/api/mcp/tokens/revocations')
      .set('Authorization', `Bearer ${bearer}`);
    // requireAdminOrSystemKey: no system key + no admin session → 401.
    expect(res.status).toBe(401);
  });

  it('revoke without a token → 400', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await request(app)
      .post('/api/mcp/tokens/revoke')
      .set('Authorization', `Bearer ${bearer}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('revoke by bare jti is NOT supported → 400 (must present the token)', async () => {
    const bearer = await makeBearer(USER_ID);
    const minted = await request(app).post('/api/mcp/tokens').set('Authorization', `Bearer ${bearer}`).send({});
    const res = await request(app)
      .post('/api/mcp/tokens/revoke')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ jti: minted.body.jti }); // bare jti — no token
    expect(res.status).toBe(400);
  });
});
