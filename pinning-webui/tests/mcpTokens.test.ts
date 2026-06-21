/**
 * Phase 11 — Scoped MCP-JWT issuer tests.
 *
 * Two layers:
 *  1. PURE-LOGIC tests (always run, no DB) — these PIN THE P12 CONTRACT: the
 *     exact scope-claim shape, mint/verify round-trip, TTL clamping, the
 *     token-confusion guard (a broad storage JWT must NOT pass as an MCP
 *     token), and the constant-prefix invariant (prefix === "ai/", the
 *     AI-workspace key namespace; cross-user isolation is the gateway's
 *     per-user bucket namespacing + the JWT `sub`, not the key prefix).
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
  normalizeMcpPubB64,
  getCnfMcpPubB64,
  MCP_TOKEN_TYP,
  MCP_TOKEN_USE,
  MCP_TOKEN_ISS,
  MCP_TOKEN_AUD,
  MCP_SCOPE_VERSION,
  MCP_WORKSPACE_BUCKET,
  MCP_WORKSPACE_PREFIX,
  MCP_PUBKEY_BYTES,
  MCP_TOKEN_TTL_DEFAULT_SECONDS,
  MCP_TOKEN_TTL_MIN_SECONDS,
  MCP_TOKEN_TTL_MAX_SECONDS,
} from '../server/mcpTokens.js';

import {
  validateGrantsPayload,
  MCP_GRANTS_MAX_PER_REQUEST,
} from '../server/mcpGrants.js';

// A real 32-byte X25519-shaped public key, standard-base64 (FxFiles convention).
const MCP_PUB_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const MCP_PUB_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64');

// A minimal serialized ShareToken (only the outer envelope matters to the store).
function sampleTokenJson(scope = 'photos/2024'): string {
  return JSON.stringify({ id: 'tok-' + scope, pathScope: scope, permissions: 'readOnly' });
}
function sampleGrant(scope = 'photos/2024', expires_at?: number | null) {
  return {
    scope,
    permissions: { can_read: true, can_write: false, can_delete: false },
    token_json: sampleTokenJson(scope),
    ...(expires_at !== undefined ? { expires_at } : {}),
  };
}

const JWT_SECRET = 'test-jwt-secret-for-testing-only';
// A 64-hex user_id, the real shape (SHA-256 of an email).
const USER_ID = emailToUserId('mcp-test@example.com');

// ============================================================================
// 1. PURE-LOGIC — the P12 contract (always runs, no database)
// ============================================================================

describe('MCP scope claim — the P12 contract', () => {
  it('buildMcpScopeClaim sets the constant ai/ prefix and defaults to all perms', () => {
    const claim = buildMcpScopeClaim();
    expect(claim.v).toBe(MCP_SCOPE_VERSION);
    expect(claim.scopes).toHaveLength(1);
    expect(claim.scopes[0].bucket).toBe(MCP_WORKSPACE_BUCKET);
    expect(claim.scopes[0].prefix).toBe(MCP_WORKSPACE_PREFIX);
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
      prefix: MCP_WORKSPACE_PREFIX,
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
    expect(claims.mcp.scopes[0].prefix).toBe(MCP_WORKSPACE_PREFIX);
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

  it('verifyMcpToken REJECTS a token whose prefix is not the constant ai/ namespace', () => {
    // The prefix is a fixed contract value (the AI-workspace key namespace).
    // A token carrying ANY other prefix — including a per-user `${sub}/`, which
    // would never match the MCP's real `ai/<category>/...` keys — is invalid.
    // (Cross-user isolation is the gateway's per-user bucket namespacing + the
    // JWT `sub`, NOT the key prefix; the prefix rule just pins the namespace.)
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
        mcp: { v: 1, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: `${USER_ID}/`, perms: ['read'] }] },
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
        mcp: { v: 2, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: MCP_WORKSPACE_PREFIX, perms: ['read'] }] },
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
        mcp: { v: 1, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: MCP_WORKSPACE_PREFIX, perms: ['read'] }] },
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

// ============================================================================
// 1b. CONNECTION-BINDING cnf claim (P15a) — always runs, no database
// ============================================================================

describe('normalizeMcpPubB64 — strict 32-byte pubkey validation', () => {
  it('accepts standard-base64 of a 32-byte key and returns canonical form', () => {
    expect(normalizeMcpPubB64(MCP_PUB_A)).toBe(MCP_PUB_A);
    // round-trips to exactly 32 bytes
    expect(Buffer.from(normalizeMcpPubB64(MCP_PUB_A)!, 'base64').length).toBe(MCP_PUBKEY_BYTES);
  });

  it('accepts the url-safe alphabet and normalizes it to standard base64', () => {
    const urlSafe = MCP_PUB_A.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const norm = normalizeMcpPubB64(urlSafe);
    expect(norm).toBe(MCP_PUB_A); // canonical standard form, padded
  });

  it('REJECTS a wrong-size key (16 bytes), empty, non-string, and junk', () => {
    const sixteen = Buffer.alloc(16, 7).toString('base64');
    expect(normalizeMcpPubB64(sixteen)).toBeNull();
    const fortyEight = Buffer.alloc(48, 7).toString('base64');
    expect(normalizeMcpPubB64(fortyEight)).toBeNull();
    expect(normalizeMcpPubB64('')).toBeNull();
    expect(normalizeMcpPubB64(undefined)).toBeNull();
    expect(normalizeMcpPubB64(null)).toBeNull();
    expect(normalizeMcpPubB64(123 as unknown)).toBeNull();
    expect(normalizeMcpPubB64('not base64!!! ***')).toBeNull();
  });
});

describe('connection-bound mint + verify (cnf claim)', () => {
  it('mintMcpToken with mcpPubB64 embeds a top-level cnf SIBLING of mcp', () => {
    const { token, claims } = mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: MCP_PUB_A });
    expect(claims.cnf).toEqual({ mcp_pub_b64: MCP_PUB_A });

    // Decode raw payload: cnf is at the TOP LEVEL, not under mcp.
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.cnf).toEqual({ mcp_pub_b64: MCP_PUB_A });
    expect(decoded.mcp.cnf).toBeUndefined(); // never a child of mcp
    expect(decoded.mcp.v).toBe(1); // mcp claim unchanged
  });

  it('default mint (no mcpPubB64) produces NO cnf key — P11 byte-compat', () => {
    const { token, claims } = mintMcpToken(USER_ID, JWT_SECRET);
    expect(claims.cnf).toBeUndefined();
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect('cnf' in decoded).toBe(false);
  });

  it('verifyMcpToken exposes cnf.mcp_pub_b64 via getCnfMcpPubB64', () => {
    const { token } = mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: MCP_PUB_A });
    const claims = verifyMcpToken(token, JWT_SECRET);
    expect(getCnfMcpPubB64(claims)).toBe(MCP_PUB_A);
  });

  it('verifyMcpToken on an UNBOUND token returns null connection (no crash)', () => {
    const { token } = mintMcpToken(USER_ID, JWT_SECRET);
    const claims = verifyMcpToken(token, JWT_SECRET);
    expect(claims.cnf).toBeUndefined();
    expect(getCnfMcpPubB64(claims)).toBeNull();
  });

  it('mintMcpToken FAILS CLOSED on a malformed mcpPubB64 (never issues unbound-as-bound)', () => {
    expect(() => mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: 'too-short' })).toThrow(/mcp_pub_b64/);
    const sixteen = Buffer.alloc(16, 1).toString('base64');
    expect(() => mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: sixteen })).toThrow(/32-byte/);
  });

  it('verifyMcpToken REJECTS a token carrying a malformed cnf (tamper guard)', () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = jwt.sign(
      {
        iss: MCP_TOKEN_ISS, aud: MCP_TOKEN_AUD, sub: USER_ID, jti: 'x',
        iat: now, nbf: now, exp: now + 600, token_use: MCP_TOKEN_USE,
        mcp: { v: 1, scopes: [{ bucket: MCP_WORKSPACE_BUCKET, prefix: MCP_WORKSPACE_PREFIX, perms: ['read'] }] },
        cnf: { mcp_pub_b64: 'not-a-32-byte-key' },
      },
      JWT_SECRET,
      { algorithm: 'HS256', header: { alg: 'HS256', typ: MCP_TOKEN_TYP } },
    );
    expect(() => verifyMcpToken(forged, JWT_SECRET)).toThrow(/cnf/);
  });

  it('two tokens bound to DIFFERENT connections expose different cnf', () => {
    const a = verifyMcpToken(mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: MCP_PUB_A }).token, JWT_SECRET);
    const b = verifyMcpToken(mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: MCP_PUB_B }).token, JWT_SECRET);
    expect(getCnfMcpPubB64(a)).toBe(MCP_PUB_A);
    expect(getCnfMcpPubB64(b)).toBe(MCP_PUB_B);
    expect(getCnfMcpPubB64(a)).not.toBe(getCnfMcpPubB64(b));
  });
});

// ============================================================================
// 1c. GRANT PAYLOAD VALIDATION (P15a) — pure, always runs, no database
// ============================================================================

describe('validateGrantsPayload — request-shape validation (pure)', () => {
  it('accepts a well-formed payload and normalizes the pubkey', () => {
    const r = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant()] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mcpPubB64).toBe(MCP_PUB_A);
      expect(r.value.grants).toHaveLength(1);
      expect(r.value.grants[0].permissions).toEqual({ can_read: true, can_write: false, can_delete: false });
      expect(r.value.grants[0].expires_at).toBeNull(); // omitted ⇒ null
    }
  });

  it('carries a numeric expires_at through (floored)', () => {
    const r = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('x', 1893456000.9)] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.grants[0].expires_at).toBe(1893456000);
  });

  it('REJECTS a wrong-size / missing pubkey (400)', () => {
    const sixteen = Buffer.alloc(16, 1).toString('base64');
    const r1 = validateGrantsPayload({ mcp_pub_b64: sixteen, grants: [sampleGrant()] });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.status).toBe(400);
    const r2 = validateGrantsPayload({ grants: [sampleGrant()] });
    expect(r2.ok).toBe(false);
  });

  it('REJECTS permissions missing one of the three bools (400)', () => {
    const bad = { scope: 's', permissions: { can_read: true, can_write: false }, token_json: sampleTokenJson() };
    const r = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: [bad] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/permissions/);
    }
  });

  it('REJECTS a non-boolean permission value (400)', () => {
    const bad = { scope: 's', permissions: { can_read: 'yes', can_write: false, can_delete: false }, token_json: sampleTokenJson() };
    const r = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: [bad] });
    expect(r.ok).toBe(false);
  });

  it('REJECTS a token_json that is not valid JSON (400)', () => {
    const bad = { scope: 's', permissions: { can_read: true, can_write: false, can_delete: false }, token_json: 'not-json{{{' };
    const r = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: [bad] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it('REJECTS an empty scope and an empty grants array (400)', () => {
    const r1 = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('')] });
    expect(r1.ok).toBe(false);
    const r2 = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: [] });
    expect(r2.ok).toBe(false);
  });

  it('REJECTS a non-object body / non-array grants (400)', () => {
    expect(validateGrantsPayload(null).ok).toBe(false);
    expect(validateGrantsPayload('x').ok).toBe(false);
    expect(validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: 'nope' }).ok).toBe(false);
  });

  it('accepts exactly the cap (1000) and REJECTS one over (413)', () => {
    const atCap = Array.from({ length: MCP_GRANTS_MAX_PER_REQUEST }, (_, i) => sampleGrant('s' + i));
    const ok = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: atCap });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.grants).toHaveLength(1000);

    const overCap = Array.from({ length: MCP_GRANTS_MAX_PER_REQUEST + 1 }, (_, i) => sampleGrant('s' + i));
    const over = validateGrantsPayload({ mcp_pub_b64: MCP_PUB_A, grants: overCap });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.status).toBe(413);
      expect(over.error).toMatch(/1000/);
    }
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

// Auth-boundary tests need NO database: an unauthenticated request is rejected
// by requireSessionOrBearer before any query() runs. These ALWAYS execute
// (the "Unauthenticated → 401" requirement must be a green test, not a skip).
describe('MCP endpoints — auth boundary (no DB)', () => {
  let app: Express;
  beforeAll(() => {
    app = createApp(testConfig, { skipRateLimit: true }).app;
  });

  it('POST /api/mcp/tokens → 401 unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/tokens').send({});
    expect(res.status).toBe(401);
  });
  it('POST /api/mcp/tokens/refresh → 401 unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/tokens/refresh').send({});
    expect(res.status).toBe(401);
  });
  it('POST /api/mcp/tokens/revoke → 401 unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/tokens/revoke').send({ token: 'x' });
    expect(res.status).toBe(401);
  });
  it('GET /api/mcp/tokens/revocations → 401 without system key / admin', async () => {
    const res = await request(app).get('/api/mcp/tokens/revocations');
    expect(res.status).toBe(401);
  });

  // P15a grant endpoints — auth boundary (no DB needed).
  it('POST /api/mcp/grants → 401 unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/grants').send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant()] });
    expect(res.status).toBe(401);
  });
  it('POST /api/mcp/grants/revoke → 401 unauthenticated', async () => {
    const res = await request(app).post('/api/mcp/grants/revoke').send({ id: 'x' });
    expect(res.status).toBe(401);
  });
  it('GET /api/mcp/grants → 401 without a Bearer MCP token', async () => {
    const res = await request(app).get('/api/mcp/grants');
    expect(res.status).toBe(401);
  });
  it('GET /api/mcp/grants → 401 when the Bearer is a storage JWT (not an MCP token)', async () => {
    // A broad storage JWT must NOT be honoured as an MCP token (token-confusion guard).
    const storageToken = generateJwtApiKey(USER_ID, JWT_SECRET);
    const res = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${storageToken}`);
    expect(res.status).toBe(401);
  });
  it('GET /api/mcp/grants → empty for a VALID but UNBOUND token (no cnf) — the security boundary, no DB', async () => {
    // SECURITY: an unbound token has no connection identity, so it must get an
    // EMPTY grant set, never all the user's grants. cnf-null is checked before
    // any DB access, so this runs green without Postgres.
    const unbound = mintMcpToken(USER_ID, JWT_SECRET).token; // no mcpPubB64 ⇒ no cnf
    const res = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${unbound}`);
    expect(res.status).toBe(200);
    expect(res.body.grants).toEqual([]);
  });
});

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
    expect(res.body.scope.scopes[0].prefix).toBe(MCP_WORKSPACE_PREFIX);

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

// ============================================================================
// 3. INTEGRATION — the P15a grant endpoints over HTTP (requires Postgres)
// ============================================================================

describe.runIf(pgAvailable)('MCP grant endpoints', () => {
  let app: Express;

  beforeAll(async () => {
    const result = createApp(testConfig, { skipRateLimit: true });
    app = result.app;
    // GET does a revocation lookup, so BOTH tables must exist.
    const { createMcpGrantsTable, createMcpRevocationTable } = await import('../server/database/postgres.js');
    await createMcpGrantsTable();
    await createMcpRevocationTable();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await query('DELETE FROM mcp_grants').catch(() => {});
    await query('DELETE FROM mcp_revoked_tokens').catch(() => {});
    await query('DELETE FROM api_keys').catch(() => {});
  });

  async function makeBearer(userId: string): Promise<string> {
    return createApiKey(userId, JWT_SECRET, generateJwtApiKey);
  }
  // A connection-bound MCP JWT for fetching grants.
  function mcpBound(userId: string, pub: string): string {
    return mintMcpToken(userId, JWT_SECRET, { mcpPubB64: pub }).token;
  }

  it('POST inserts grants and returns ids (201)', async () => {
    const bearer = await makeBearer(USER_ID);
    const res = await request(app)
      .post('/api/mcp/grants')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('a/1'), sampleGrant('a/2')] });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(2);
    expect(res.body.ids).toHaveLength(2);
  });

  it('POST rejects a malformed payload (400) and the over-cap request (413)', async () => {
    const bearer = await makeBearer(USER_ID);
    const bad = await request(app)
      .post('/api/mcp/grants')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [{ scope: 's', permissions: { can_read: true } }] });
    expect(bad.status).toBe(400);
  });

  // ── THE leak-prevention assertion ──────────────────────────────────────
  it('GET returns ONLY connection A grants, NEVER connection B (cross-agent isolation)', async () => {
    const bearer = await makeBearer(USER_ID);
    // Same user publishes grants for TWO different connections.
    await request(app).post('/api/mcp/grants').set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('A/photos'), sampleGrant('A/docs')] });
    await request(app).post('/api/mcp/grants').set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_B, grants: [sampleGrant('B/secret')] });

    // Connection A's MCP fetches with its OWN bound token.
    const resA = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${mcpBound(USER_ID, MCP_PUB_A)}`);
    expect(resA.status).toBe(200);
    // Assert SET membership (bulk insert shares created_at ⇒ order is non-deterministic).
    const scopesA = new Set(resA.body.grants.map((g: any) => g.scope));
    expect(scopesA).toEqual(new Set(['A/photos', 'A/docs']));
    expect(scopesA.has('B/secret')).toBe(false); // ← the boundary: B's path is invisible to A

    // Connection B sees only its own.
    const resB = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${mcpBound(USER_ID, MCP_PUB_B)}`);
    const scopesB = new Set(resB.body.grants.map((g: any) => g.scope));
    expect(scopesB).toEqual(new Set(['B/secret']));
    expect(scopesB.has('A/photos')).toBe(false);

    // The returned rows carry the full envelope the MCP needs to merge.
    const one = resA.body.grants[0];
    expect(one).toHaveProperty('id');
    expect(one).toHaveProperty('token_json');
    expect(one.permissions).toEqual({ can_read: true, can_write: false, can_delete: false });
  });

  it('GET excludes a revoked grant row', async () => {
    const bearer = await makeBearer(USER_ID);
    const post = await request(app).post('/api/mcp/grants').set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('keep'), sampleGrant('drop')] });
    expect(post.status).toBe(201);

    // Revoke the "drop" grant by (mcp_pub_b64, scope).
    const rev = await request(app).post('/api/mcp/grants/revoke').set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, scope: 'drop' });
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(1);

    const got = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${mcpBound(USER_ID, MCP_PUB_A)}`);
    const scopes = got.body.grants.map((g: any) => g.scope);
    expect(scopes).toContain('keep');
    expect(scopes).not.toContain('drop');
  });

  it('revoke by id drops exactly that row', async () => {
    const bearer = await makeBearer(USER_ID);
    const post = await request(app).post('/api/mcp/grants').set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('one'), sampleGrant('two')] });
    const idToRevoke = post.body.ids[0];

    const rev = await request(app).post('/api/mcp/grants/revoke').set('Authorization', `Bearer ${bearer}`)
      .send({ id: idToRevoke });
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(1);

    const got = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${mcpBound(USER_ID, MCP_PUB_A)}`);
    expect(got.body.grants).toHaveLength(1); // one of the two remains
  });

  it('GET excludes an EXPIRED grant', async () => {
    const bearer = await makeBearer(USER_ID);
    const past = Math.floor(Date.now() / 1000) - 100;
    const future = Math.floor(Date.now() / 1000) + 10_000;
    await request(app).post('/api/mcp/grants').set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('alive', future), sampleGrant('dead', past)] });

    const got = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${mcpBound(USER_ID, MCP_PUB_A)}`);
    const scopes = got.body.grants.map((g: any) => g.scope);
    expect(scopes).toContain('alive');
    expect(scopes).not.toContain('dead');
  });

  it('GET with a REVOKED MCP token → 401 (revocation enforced on the fetch path)', async () => {
    const bearer = await makeBearer(USER_ID);
    await request(app).post('/api/mcp/grants').set('Authorization', `Bearer ${bearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('x')] });

    const bound = mintMcpToken(USER_ID, JWT_SECRET, { mcpPubB64: MCP_PUB_A });
    // Revoke that exact token via the token-revoke endpoint.
    const rev = await request(app).post('/api/mcp/tokens/revoke').set('Authorization', `Bearer ${bearer}`)
      .send({ token: bound.token });
    expect(rev.status).toBe(200);

    const got = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${bound.token}`);
    expect(got.status).toBe(401);
  });

  it("a user cannot revoke ANOTHER user's grant by id (user-scoped)", async () => {
    const victimBearer = await makeBearer(USER_ID);
    const post = await request(app).post('/api/mcp/grants').set('Authorization', `Bearer ${victimBearer}`)
      .send({ mcp_pub_b64: MCP_PUB_A, grants: [sampleGrant('victim')] });
    const victimGrantId = post.body.ids[0];

    const attackerId = emailToUserId('attacker@example.com');
    const attackerBearer = await makeBearer(attackerId);
    const rev = await request(app).post('/api/mcp/grants/revoke').set('Authorization', `Bearer ${attackerBearer}`)
      .send({ id: victimGrantId });
    // Revoke is user-scoped: attacker's revoke matches 0 of the victim's rows.
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(0);

    // Victim's grant is still live.
    const got = await request(app).get('/api/mcp/grants').set('Authorization', `Bearer ${mcpBound(USER_ID, MCP_PUB_A)}`);
    expect(got.body.grants.map((g: any) => g.scope)).toContain('victim');
  });
});
