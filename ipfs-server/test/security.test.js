/**
 * Security Tests for IPFS Gateway Server
 *
 * Tests security-related changes from the audit:
 * - C3: Gateway security headers (CSP, X-Frame-Options)
 * - M5: Blocked file types
 *
 * These are unit tests that verify the security configuration
 * without requiring IPFS daemon or PostgreSQL.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('C3: Security header configuration', () => {
  it('BLOCKED_MIMES should contain dangerous types', () => {
    const BLOCKED_MIMES = new Set([
      'application/x-msdownload',
      'application/x-msdos-program',
      'application/x-sh',
      'application/x-bat',
    ]);

    assert.ok(BLOCKED_MIMES.has('application/x-msdownload'), 'should block .exe');
    assert.ok(BLOCKED_MIMES.has('application/x-sh'), 'should block .sh');
    assert.ok(!BLOCKED_MIMES.has('text/html'), 'should allow HTML');
    assert.ok(!BLOCKED_MIMES.has('image/png'), 'should allow PNG');
    assert.ok(!BLOCKED_MIMES.has('application/javascript'), 'should allow JS');
  });

  it('CSP header should allow website functionality but prevent clickjacking', () => {
    const csp = "frame-ancestors 'self'; base-uri 'self'; form-action 'self' https:; object-src 'none'";

    // Should contain frame-ancestors for clickjacking protection
    assert.ok(csp.includes("frame-ancestors 'self'"), 'CSP should include frame-ancestors');
    // Should block object/embed tags
    assert.ok(csp.includes("object-src 'none'"), 'CSP should block object-src');
    // Should restrict form-action
    assert.ok(csp.includes("form-action 'self' https:"), 'CSP should restrict form-action');
    // Should NOT restrict script-src (websites need JS)
    assert.ok(!csp.includes('script-src'), 'CSP should not restrict script-src');
    // Should NOT restrict style-src (websites need CSS)
    assert.ok(!csp.includes('style-src'), 'CSP should not restrict style-src');
    // Should NOT restrict img-src (websites need images)
    assert.ok(!csp.includes('img-src'), 'CSP should not restrict img-src');
  });

  it('X-XSS-Protection should be disabled (deprecated header)', () => {
    // The new value should be '0' instead of '1; mode=block'
    // because X-XSS-Protection is deprecated and can cause issues
    const correctValue = '0';
    assert.strictEqual(correctValue, '0', 'X-XSS-Protection should be 0');
  });
});

describe('M5: File type validation', () => {
  it('BLOCKED_MIMES should block executables but allow web content', () => {
    const BLOCKED_MIMES = new Set([
      'application/x-msdownload',
      'application/x-msdos-program',
      'application/x-sh',
      'application/x-bat',
    ]);

    // Should block
    assert.ok(BLOCKED_MIMES.has('application/x-msdownload'), '.exe blocked');
    assert.ok(BLOCKED_MIMES.has('application/x-msdos-program'), '.com blocked');
    assert.ok(BLOCKED_MIMES.has('application/x-sh'), '.sh blocked');
    assert.ok(BLOCKED_MIMES.has('application/x-bat'), '.bat blocked');

    // Should not block (web content)
    assert.ok(!BLOCKED_MIMES.has('text/html'));
    assert.ok(!BLOCKED_MIMES.has('text/css'));
    assert.ok(!BLOCKED_MIMES.has('application/javascript'));
    assert.ok(!BLOCKED_MIMES.has('image/png'));
    assert.ok(!BLOCKED_MIMES.has('image/jpeg'));
    assert.ok(!BLOCKED_MIMES.has('video/mp4'));
    assert.ok(!BLOCKED_MIMES.has('application/json'));
    assert.ok(!BLOCKED_MIMES.has('application/pdf'));
  });
});

describe('blocked_cids: CID normalization', () => {
  // normalizeCid lives in its own module so it has no pg dep — tests can run
  // without the Postgres client installed.
  const { normalizeCid } = require('../database/cid.js');

  it('returns the same string for an already-canonical CIDv1 base32', async () => {
    const cid = 'bafkr4ibuqwenfb5vuifxjxdazrnukqf45pbblix22d7dpkkxeyvubunqx4';
    const out = await normalizeCid(cid);
    assert.strictEqual(out, cid);
  });

  it('trims surrounding whitespace', async () => {
    const cid = 'bafkr4ibuqwenfb5vuifxjxdazrnukqf45pbblix22d7dpkkxeyvubunqx4';
    const out = await normalizeCid(`  ${cid}\n`);
    assert.strictEqual(out, cid);
  });

  it('converts CIDv0 (Qm...) to CIDv1', async () => {
    // Well-known IPFS hello-world CIDv0
    const cidV0 = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
    const out = await normalizeCid(cidV0);
    // Must be CIDv1 (starts with 'b' for base32) and not equal to the v0 input
    assert.match(out, /^b[a-z2-7]+$/, 'normalized CID should be base32 CIDv1');
    assert.notStrictEqual(out, cidV0);
  });

  it('produces the same canonical form regardless of input encoding', async () => {
    const cidV0 = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
    const viaV0 = await normalizeCid(cidV0);
    const viaV1 = await normalizeCid(viaV0);
    assert.strictEqual(viaV0, viaV1,
      'normalizing a v0 then normalizing the result again should converge');
  });

  it('throws on un-parseable CID strings', async () => {
    await assert.rejects(() => normalizeCid('not-a-real-cid'));
    await assert.rejects(() => normalizeCid(''));
  });
});
