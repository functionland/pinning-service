import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyServiceAuth } from '../server/serviceAuth.js';

// Mirrors the Fula S3 gateway (Rust) minter — the cross-language reference.
function mint(userId: string, exp: number, secret: string): string {
  const uidB64 = Buffer.from(userId).toString('base64url');
  const msg = `v1.${uidB64}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(msg).digest('base64url');
  return `${msg}.${sig}`;
}

// SHARED VECTOR — identical inputs/header to the Go (service_auth_test.go) and
// Rust (service_auth.rs) tests. This is the cross-language lock.
const VEC_SECRET = 'fula-pin-svc-shared-test-secret-rotate-me';
const VEC_USER = '2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff';
const VEC_EXP = 4102444800;
const VEC_HEADER =
  'v1.MmQyZGZmZmRhZDYyZmY5MjdhYmJhMTI5NWM3M2E0ZWFiNzY2NjgxMzI4MGVhOGIzNTZkYTg0NWU0NDBjNDFmZg.4102444800.7kiFsUP9DMnoeP00uwbUwy4tJmTC6rpy9Dce_e-jw3U';

describe('serviceAuth', () => {
  it('matches + verifies the shared cross-language vector (locks Go/Rust/TS)', () => {
    expect(mint(VEC_USER, VEC_EXP, VEC_SECRET)).toBe(VEC_HEADER); // minter parity
    expect(verifyServiceAuth(VEC_HEADER, VEC_SECRET)).toBe(VEC_USER); // verifier parity
  });

  it('rejects wrong secret', () => {
    expect(verifyServiceAuth(VEC_HEADER, 'a-totally-different-secret')).toBeNull();
  });

  it('rejects empty / disabled secret', () => {
    expect(verifyServiceAuth(VEC_HEADER, '')).toBeNull();
    expect(verifyServiceAuth(VEC_HEADER, 'disabled')).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const p = VEC_HEADER.split('.');
    p[3] = Buffer.from('not-the-real-hmac-32-bytes-xxxxx').toString('base64url');
    expect(verifyServiceAuth(p.join('.'), VEC_SECRET)).toBeNull();
  });

  it('rejects a user-id swap that keeps the signature (binding holds)', () => {
    const p = VEC_HEADER.split('.');
    p[1] = Buffer.from('victim-other-user').toString('base64url');
    expect(verifyServiceAuth(p.join('.'), VEC_SECRET)).toBeNull();
  });

  it('rejects expired', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(verifyServiceAuth(mint(VEC_USER, past, VEC_SECRET), VEC_SECRET)).toBeNull();
  });

  it('rejects malformed / bad version / absent', () => {
    expect(verifyServiceAuth('v1.abc.123', VEC_SECRET)).toBeNull();
    expect(verifyServiceAuth('v2.' + VEC_HEADER.split('.').slice(1).join('.'), VEC_SECRET)).toBeNull();
    expect(verifyServiceAuth(undefined, VEC_SECRET)).toBeNull();
  });

  it('round-trips a freshly minted token', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(verifyServiceAuth(mint('user-xyz', exp, VEC_SECRET), VEC_SECRET)).toBe('user-xyz');
  });
});
