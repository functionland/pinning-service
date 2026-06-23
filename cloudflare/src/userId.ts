/**
 * Fula identity derivation — MUST stay byte-for-byte identical to the
 * pinning-webui's `emailToUserId` (pinning-webui/server/utils/hash.ts):
 *
 *   crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')
 *
 * i.e. SHA-256 of the lowercased email, lowercase HEX encoded (64 chars). The
 * hosted MCP and the webui MUST agree on this so a user authenticating through
 * either path maps to the SAME `user_id`. Diverging (skipping the lowercase, or
 * emitting base64) would split one user into two identities. The Workers runtime
 * has no `node:crypto.createHash`; we use the WebCrypto SubtleCrypto digest,
 * which produces the same bytes, then hex-encode them ourselves.
 */

/** SHA-256(lowercased `email`) as lowercase hex. The Fula `user_id`. */
export async function emailToUserId(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}
