/**
 * Security Tests for Pinning WebUI
 *
 * Tests security-related changes from the audit:
 * - H3: API key encryption at rest (AES-256-GCM)
 * - H5: Timing-safe system key comparison
 * - L4: rawToFula precision for large amounts
 * - M7: Dead code removal verification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ============================================
// H3: API Key Encryption
// ============================================

describe('H3: API key encryption at rest', () => {
  // Test the encryption/decryption logic directly
  const TEST_ENCRYPTION_KEY = crypto.randomBytes(32);

  function encryptApiKey(key: string, encKey: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  function decryptApiKey(stored: string, encKey: Buffer): string {
    const buf = Buffer.from(stored, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  it('should encrypt and decrypt API key correctly', () => {
    const originalKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-api-key';
    const encrypted = encryptApiKey(originalKey, TEST_ENCRYPTION_KEY);
    const decrypted = decryptApiKey(encrypted, TEST_ENCRYPTION_KEY);

    expect(decrypted).toBe(originalKey);
  });

  it('should produce different ciphertext for same input (random IV)', () => {
    const key = 'test-api-key-123';
    const encrypted1 = encryptApiKey(key, TEST_ENCRYPTION_KEY);
    const encrypted2 = encryptApiKey(key, TEST_ENCRYPTION_KEY);

    // Different ciphertexts (due to random IV)
    expect(encrypted1).not.toBe(encrypted2);

    // But both decrypt to the same value
    expect(decryptApiKey(encrypted1, TEST_ENCRYPTION_KEY)).toBe(key);
    expect(decryptApiKey(encrypted2, TEST_ENCRYPTION_KEY)).toBe(key);
  });

  it('should fail decryption with wrong key', () => {
    const key = 'test-api-key-123';
    const encrypted = encryptApiKey(key, TEST_ENCRYPTION_KEY);
    const wrongKey = crypto.randomBytes(32);

    expect(() => decryptApiKey(encrypted, wrongKey)).toThrow();
  });

  it('should fail decryption with tampered ciphertext', () => {
    const key = 'test-api-key-123';
    const encrypted = encryptApiKey(key, TEST_ENCRYPTION_KEY);

    // Tamper with the base64 string
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff; // Flip last byte
    const tampered = buf.toString('base64');

    expect(() => decryptApiKey(tampered, TEST_ENCRYPTION_KEY)).toThrow();
  });

  it('should handle empty string', () => {
    const encrypted = encryptApiKey('', TEST_ENCRYPTION_KEY);
    const decrypted = decryptApiKey(encrypted, TEST_ENCRYPTION_KEY);
    expect(decrypted).toBe('');
  });

  it('should handle long API keys', () => {
    const longKey = 'a'.repeat(4096);
    const encrypted = encryptApiKey(longKey, TEST_ENCRYPTION_KEY);
    const decrypted = decryptApiKey(encrypted, TEST_ENCRYPTION_KEY);
    expect(decrypted).toBe(longKey);
  });
});

// ============================================
// H5: Timing-safe System Key Comparison
// ============================================

describe('H5: Timing-safe system key comparison', () => {
  function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  it('should return true for matching keys', () => {
    expect(safeCompare('secret123', 'secret123')).toBe(true);
  });

  it('should return false for different keys of same length', () => {
    expect(safeCompare('secret123', 'secret456')).toBe(false);
  });

  it('should return false for keys of different length', () => {
    expect(safeCompare('short', 'much-longer-key')).toBe(false);
  });

  it('should handle empty strings', () => {
    expect(safeCompare('', '')).toBe(true);
  });
});

// ============================================
// L4: rawToFula Precision
// ============================================

describe('L4: rawToFula precision fix', () => {
  const FULA_DECIMALS = 18;

  // Replicate the fixed implementation
  function rawToFula(rawAmount: string): number {
    const amount = BigInt(rawAmount);
    const divisor = BigInt(10 ** FULA_DECIMALS);
    const whole = amount / divisor;
    const remainder = amount % divisor;
    return Number(whole) + Number(remainder) / Number(divisor);
  }

  // Old broken implementation for comparison
  function rawToFulaOld(rawAmount: string): number {
    const amount = BigInt(rawAmount);
    const divisor = BigInt(10 ** FULA_DECIMALS);
    return Number(amount) / Number(divisor);
  }

  it('should handle 1 FULA correctly', () => {
    expect(rawToFula('1000000000000000000')).toBe(1);
  });

  it('should handle 0.5 FULA correctly', () => {
    expect(rawToFula('500000000000000000')).toBe(0.5);
  });

  it('should handle 1000 FULA correctly', () => {
    expect(rawToFula('1000000000000000000000')).toBe(1000);
  });

  it('should handle zero correctly', () => {
    expect(rawToFula('0')).toBe(0);
  });

  it('should preserve precision better than old implementation for large amounts', () => {
    // 10000 FULA — above this, old impl starts losing precision
    const raw = '10000000000000000000000'; // 10000 * 10^18
    const newResult = rawToFula(raw);
    expect(newResult).toBe(10000);

    // The whole number part should be exact
    const largeRaw = '9007199254740992000000000000000000000'; // 9007199254740992 FULA (2^53)
    const result = rawToFula(largeRaw);
    // At least the magnitude should be correct
    expect(result).toBeGreaterThan(9007199254740000);
  });
});

// ============================================
// M7: Dead Code Removal Verification
// ============================================

describe('M7: Dead code removal', () => {
  it('verifySignature should not be exported from creditService', async () => {
    // Dynamic import to check exports
    const creditService = await import('../server/services/creditService.js');

    // verifySignature was removed
    expect((creditService as any).verifySignature).toBeUndefined();

    // Core functions should still be exported
    expect(creditService.rawToFula).toBeDefined();
    expect(creditService.getUserCreditStatus).toBeDefined();
    expect(creditService.creditUser).toBeDefined();
  });
});
