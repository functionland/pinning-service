/**
 * Tests for the seed-derived auth endpoints (audit F-A1 / F-A3 redesign).
 *
 * Covers `/auth/register-mode-c`, `/auth/challenge`, and `/auth/sign-in`.
 * `/auth/register-mode-b` adds OAuth verification on top of the same
 * core logic; that branch is exercised by mocking the Google client at
 * the unit-test level, not here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import type { Express } from 'express';
import { createApp, type AppConfig } from '../server/app.js';
import { createPostgresPool, closePool, query } from '../server/database/postgres.js';
import { buildSignedTranscript, type Purpose } from '../server/services/seedAuth.js';

const testConfig: AppConfig = {
  port: 3098,
  googleClientId: 'test-google-client-id',
  sessionSecret: 'test-session-secret-for-testing-only',
  jwtSecret: 'test-jwt-secret-for-testing-only',
  nodeEnv: 'test',
  pinningServiceUrl: 'http://localhost:6000',
};

// Skip the whole suite if Postgres isn't reachable — same pattern as
// the existing `api.test.ts`.
let pgAvailable = false;
try {
  const pool = createPostgresPool();
  const client = await pool.connect();
  client.release();
  pgAvailable = true;
} catch {
  console.warn('[test] PostgreSQL not available — skipping seedAuth tests');
  await closePool();
}

// ---------- Ed25519 keypair helpers (Node built-in) ----------

/** ASN.1/DER SPKI prefix for an Ed25519 public key (same as the server). */
const ED25519_SPKI_PREFIX_LEN = 12;

function freshKeypair(): { publicKeyRaw: Buffer; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = Buffer.from(spki.subarray(ED25519_SPKI_PREFIX_LEN));
  expect(raw.length).toBe(32);
  return { publicKeyRaw: raw, privateKey };
}

function signTranscript(
  privateKey: crypto.KeyObject,
  purpose: Purpose,
  effectiveUserIdHex: string,
  challenge: Buffer
): Buffer {
  const msg = buildSignedTranscript(purpose, effectiveUserIdHex, challenge);
  return crypto.sign(null, msg, privateKey);
}

/** Generate a syntactically-valid `effective_user_id_hex` (32 lowercase hex chars). */
function freshEffectiveUserId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ---------- DB cleanup ----------

async function clearSeedTables(): Promise<void> {
  await query('DELETE FROM seed_users').catch(() => {});
  // Also clean any webui_users rows we created — the test ids look like
  // 32-char hex but webui_users.user_id is VARCHAR(64) so legitimate
  // 64-char SHA-256 emails would not collide.
  await query(`DELETE FROM webui_users WHERE LENGTH(user_id) = 32`).catch(() => {});
}

describe.runIf(pgAvailable)('Seed-auth endpoints', () => {
  let app: Express;

  beforeAll(async () => {
    const result = createApp(testConfig, { skipRateLimit: true });
    app = result.app;
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await clearSeedTables();
  });

  // ============================================================
  // /auth/register-mode-c
  // ============================================================

  describe('POST /auth/register-mode-c', () => {
    it('happy path: registers a Mode C user and returns a JWT', async () => {
      const { publicKeyRaw, privateKey } = freshKeypair();
      const effectiveUserIdHex = freshEffectiveUserId();
      const challenge = crypto.randomBytes(32);
      const signature = signTranscript(
        privateKey,
        'register-mode-c',
        effectiveUserIdHex,
        challenge
      );

      const res = await request(app)
        .post('/auth/register-mode-c')
        .send({
          effective_user_id_hex: effectiveUserIdHex,
          public_key_b64: publicKeyRaw.toString('base64'),
          challenge_b64: challenge.toString('base64'),
          signature_b64: signature.toString('base64'),
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mode).toBe('C');
      expect(res.body.created).toBe(true);
      expect(res.body.effective_user_id_hex).toBe(effectiveUserIdHex);
      expect(typeof res.body.jwt).toBe('string');

      // JWT sub matches the supplied effective_user_id.
      const claims = JSON.parse(
        Buffer.from(res.body.jwt.split('.')[1], 'base64url').toString('utf8')
      );
      expect(claims.sub).toBe(effectiveUserIdHex);
      expect(claims.scope).toBe('storage:read storage:write');
    });

    it('idempotent: same key re-registers without conflict', async () => {
      const { publicKeyRaw, privateKey } = freshKeypair();
      const effectiveUserIdHex = freshEffectiveUserId();

      for (const expectedCreated of [true, false]) {
        const challenge = crypto.randomBytes(32);
        const signature = signTranscript(
          privateKey,
          'register-mode-c',
          effectiveUserIdHex,
          challenge
        );
        const res = await request(app)
          .post('/auth/register-mode-c')
          .send({
            effective_user_id_hex: effectiveUserIdHex,
            public_key_b64: publicKeyRaw.toString('base64'),
            challenge_b64: challenge.toString('base64'),
            signature_b64: signature.toString('base64'),
          });
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(expectedCreated);
      }
    });

    it('squatting: different key for same effective_user_id → 409', async () => {
      const effectiveUserIdHex = freshEffectiveUserId();
      const alice = freshKeypair();
      const aliceChallenge = crypto.randomBytes(32);
      const aliceSig = signTranscript(
        alice.privateKey,
        'register-mode-c',
        effectiveUserIdHex,
        aliceChallenge
      );
      let res = await request(app)
        .post('/auth/register-mode-c')
        .send({
          effective_user_id_hex: effectiveUserIdHex,
          public_key_b64: alice.publicKeyRaw.toString('base64'),
          challenge_b64: aliceChallenge.toString('base64'),
          signature_b64: aliceSig.toString('base64'),
        });
      expect(res.status).toBe(200);

      // Different keypair, same effective_user_id → squatting.
      const bob = freshKeypair();
      const bobChallenge = crypto.randomBytes(32);
      const bobSig = signTranscript(
        bob.privateKey,
        'register-mode-c',
        effectiveUserIdHex,
        bobChallenge
      );
      res = await request(app)
        .post('/auth/register-mode-c')
        .send({
          effective_user_id_hex: effectiveUserIdHex,
          public_key_b64: bob.publicKeyRaw.toString('base64'),
          challenge_b64: bobChallenge.toString('base64'),
          signature_b64: bobSig.toString('base64'),
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PUBLIC_KEY_MISMATCH');
    });

    it('bad signature: 401 SIGNATURE_INVALID', async () => {
      const { publicKeyRaw, privateKey } = freshKeypair();
      const effectiveUserIdHex = freshEffectiveUserId();
      const challenge = crypto.randomBytes(32);
      // Sign a DIFFERENT transcript than what the server reconstructs.
      const wrongSignature = crypto.sign(
        null,
        Buffer.from('totally wrong bytes'),
        privateKey
      );

      const res = await request(app)
        .post('/auth/register-mode-c')
        .send({
          effective_user_id_hex: effectiveUserIdHex,
          public_key_b64: publicKeyRaw.toString('base64'),
          challenge_b64: challenge.toString('base64'),
          signature_b64: wrongSignature.toString('base64'),
        });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('cross-purpose signature replay: a register signature cannot be reused at sign-in', async () => {
      // Register normally.
      const { publicKeyRaw, privateKey } = freshKeypair();
      const effectiveUserIdHex = freshEffectiveUserId();
      const regChallenge = crypto.randomBytes(32);
      const regSignature = signTranscript(
        privateKey,
        'register-mode-c',
        effectiveUserIdHex,
        regChallenge
      );
      let res = await request(app).post('/auth/register-mode-c').send({
        effective_user_id_hex: effectiveUserIdHex,
        public_key_b64: publicKeyRaw.toString('base64'),
        challenge_b64: regChallenge.toString('base64'),
        signature_b64: regSignature.toString('base64'),
      });
      expect(res.status).toBe(200);

      // Get a fresh challenge from /auth/challenge.
      const chRes = await request(app)
        .post('/auth/challenge')
        .send({ effective_user_id_hex: effectiveUserIdHex });
      expect(chRes.status).toBe(200);
      const signinChallenge = Buffer.from(chRes.body.challenge_b64, 'base64');

      // Replay the REGISTER signature against sign-in by submitting
      // the same signature bytes but for the sign-in purpose. Domain
      // separation in the transcript means the server-built sign-in
      // transcript differs from the register transcript → verify
      // fails.
      res = await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: effectiveUserIdHex,
        challenge_b64: signinChallenge.toString('base64'),
        signature_b64: regSignature.toString('base64'),
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('malformed effective_user_id_hex: 400 VALIDATION_ERROR', async () => {
      const { publicKeyRaw, privateKey } = freshKeypair();
      const badIds = [
        '',                                    // empty
        'ABCD',                                // too short + uppercase
        '0123456789abcdef0123456789abcdef00', // too long
        '0123456789abcdef0123456789abcdeG',   // bad char
        '0123456789ABCDEF0123456789ABCDEF',   // uppercase
      ];
      for (const badId of badIds) {
        const challenge = crypto.randomBytes(32);
        // Don't bother signing — validation happens before signature check.
        const fakeSig = crypto.sign(null, Buffer.from('x'), privateKey);
        const res = await request(app).post('/auth/register-mode-c').send({
          effective_user_id_hex: badId,
          public_key_b64: publicKeyRaw.toString('base64'),
          challenge_b64: challenge.toString('base64'),
          signature_b64: fakeSig.toString('base64'),
        });
        expect(res.status, `bad id "${badId}"`).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('bad public_key length: 400 VALIDATION_ERROR', async () => {
      const effectiveUserIdHex = freshEffectiveUserId();
      const res = await request(app).post('/auth/register-mode-c').send({
        effective_user_id_hex: effectiveUserIdHex,
        public_key_b64: Buffer.alloc(31).toString('base64'),       // 31 bytes, not 32
        challenge_b64: Buffer.alloc(32).toString('base64'),
        signature_b64: Buffer.alloc(64).toString('base64'),
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ============================================================
  // /auth/challenge
  // ============================================================

  describe('POST /auth/challenge', () => {
    it('returns 404 for an unknown effective_user_id', async () => {
      const res = await request(app)
        .post('/auth/challenge')
        .send({ effective_user_id_hex: freshEffectiveUserId() });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
    });

    it('returns 200 with a base64 32-byte challenge for a known user', async () => {
      const { publicKeyRaw, privateKey } = freshKeypair();
      const effectiveUserIdHex = freshEffectiveUserId();
      const challenge = crypto.randomBytes(32);
      const signature = signTranscript(
        privateKey,
        'register-mode-c',
        effectiveUserIdHex,
        challenge
      );
      await request(app).post('/auth/register-mode-c').send({
        effective_user_id_hex: effectiveUserIdHex,
        public_key_b64: publicKeyRaw.toString('base64'),
        challenge_b64: challenge.toString('base64'),
        signature_b64: signature.toString('base64'),
      });

      const res = await request(app)
        .post('/auth/challenge')
        .send({ effective_user_id_hex: effectiveUserIdHex });
      expect(res.status).toBe(200);
      expect(typeof res.body.challenge_b64).toBe('string');
      expect(Buffer.from(res.body.challenge_b64, 'base64').length).toBe(32);
    });
  });

  // ============================================================
  // /auth/sign-in
  // ============================================================

  describe('POST /auth/sign-in', () => {
    async function registerAndChallenge(): Promise<{
      effectiveUserIdHex: string;
      privateKey: crypto.KeyObject;
      challenge: Buffer;
    }> {
      const { publicKeyRaw, privateKey } = freshKeypair();
      const effectiveUserIdHex = freshEffectiveUserId();
      const regChallenge = crypto.randomBytes(32);
      const regSig = signTranscript(
        privateKey,
        'register-mode-c',
        effectiveUserIdHex,
        regChallenge
      );
      await request(app).post('/auth/register-mode-c').send({
        effective_user_id_hex: effectiveUserIdHex,
        public_key_b64: publicKeyRaw.toString('base64'),
        challenge_b64: regChallenge.toString('base64'),
        signature_b64: regSig.toString('base64'),
      });
      const ch = await request(app)
        .post('/auth/challenge')
        .send({ effective_user_id_hex: effectiveUserIdHex });
      return {
        effectiveUserIdHex,
        privateKey,
        challenge: Buffer.from(ch.body.challenge_b64, 'base64'),
      };
    }

    it('happy path: valid signed challenge → 200 + JWT', async () => {
      const { effectiveUserIdHex, privateKey, challenge } =
        await registerAndChallenge();
      const sig = signTranscript(
        privateKey,
        'sign-in',
        effectiveUserIdHex,
        challenge
      );
      const res = await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: effectiveUserIdHex,
        challenge_b64: challenge.toString('base64'),
        signature_b64: sig.toString('base64'),
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mode).toBe('C');
      expect(typeof res.body.jwt).toBe('string');
    });

    it('replay: re-using a challenge after a successful sign-in → 401', async () => {
      const { effectiveUserIdHex, privateKey, challenge } =
        await registerAndChallenge();
      const sig = signTranscript(
        privateKey,
        'sign-in',
        effectiveUserIdHex,
        challenge
      );
      await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: effectiveUserIdHex,
        challenge_b64: challenge.toString('base64'),
        signature_b64: sig.toString('base64'),
      });
      // Second attempt with same challenge — should fail (nonce was consumed).
      const replayRes = await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: effectiveUserIdHex,
        challenge_b64: challenge.toString('base64'),
        signature_b64: sig.toString('base64'),
      });
      expect(replayRes.status).toBe(401);
      expect(replayRes.body.code).toBe('CHALLENGE_INVALID');
    });

    it('wrong signature → 401 SIGNATURE_INVALID', async () => {
      const { effectiveUserIdHex, challenge } = await registerAndChallenge();
      // Sign with a DIFFERENT (random) keypair — challenge is valid
      // but the signature doesn't match the stored public key.
      const { privateKey: attackerPriv } = freshKeypair();
      const wrongSig = signTranscript(
        attackerPriv,
        'sign-in',
        effectiveUserIdHex,
        challenge
      );
      const res = await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: effectiveUserIdHex,
        challenge_b64: challenge.toString('base64'),
        signature_b64: wrongSig.toString('base64'),
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('challenge tampering → 401 CHALLENGE_INVALID', async () => {
      const { effectiveUserIdHex, privateKey, challenge } =
        await registerAndChallenge();
      // Server issued `challenge`; attacker submits a DIFFERENT challenge.
      const tampered = crypto.randomBytes(32);
      const sigOverTampered = signTranscript(
        privateKey,
        'sign-in',
        effectiveUserIdHex,
        tampered
      );
      const res = await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: effectiveUserIdHex,
        challenge_b64: tampered.toString('base64'),
        signature_b64: sigOverTampered.toString('base64'),
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('CHALLENGE_INVALID');
    });

    it('no prior challenge issued → 401', async () => {
      const { publicKeyRaw, privateKey } = freshKeypair();
      const effectiveUserIdHex = freshEffectiveUserId();
      const regChallenge = crypto.randomBytes(32);
      const regSig = signTranscript(
        privateKey,
        'register-mode-c',
        effectiveUserIdHex,
        regChallenge
      );
      await request(app).post('/auth/register-mode-c').send({
        effective_user_id_hex: effectiveUserIdHex,
        public_key_b64: publicKeyRaw.toString('base64'),
        challenge_b64: regChallenge.toString('base64'),
        signature_b64: regSig.toString('base64'),
      });
      // Skip /auth/challenge; go straight to sign-in.
      const challenge = crypto.randomBytes(32);
      const sig = signTranscript(
        privateKey,
        'sign-in',
        effectiveUserIdHex,
        challenge
      );
      const res = await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: effectiveUserIdHex,
        challenge_b64: challenge.toString('base64'),
        signature_b64: sig.toString('base64'),
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('CHALLENGE_INVALID');
    });

    it('cross-user signature: alice cannot sign in as bob', async () => {
      // Register both alice and bob.
      const alice = await registerAndChallenge();
      const bob = await registerAndChallenge();

      // Alice signs with HER private key over BOB's challenge + uid.
      const aliceSigForBob = signTranscript(
        alice.privateKey,
        'sign-in',
        bob.effectiveUserIdHex,
        bob.challenge
      );
      const res = await request(app).post('/auth/sign-in').send({
        effective_user_id_hex: bob.effectiveUserIdHex,
        challenge_b64: bob.challenge.toString('base64'),
        signature_b64: aliceSigForBob.toString('base64'),
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });
  });
});
