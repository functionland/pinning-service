import crypto from 'crypto';

/**
 * Deterministic user_id from email.
 * SHA-256 of lowercase email, hex-encoded (64 chars).
 * This is a one-way function — email cannot be recovered.
 */
export function emailToUserId(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
}

/**
 * SHA-256 hash for wallet address lookup.
 */
export function hashWalletAddress(address: string): string {
  return crypto.createHash('sha256').update(address.toLowerCase()).digest('hex');
}

/**
 * Backward-compatible JWT sub handler.
 * Old JWTs have sub=email. New JWTs have sub=sha256(email).
 * If sub looks like an email (contains @), hash it.
 */
export function getUserId(jwtSub: string): string {
  return jwtSub.includes('@') ? emailToUserId(jwtSub) : jwtSub;
}
