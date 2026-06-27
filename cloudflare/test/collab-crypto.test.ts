/**
 * Collab-crypto parity + round-trip (the task's required 3-way-parity anchor).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The collaboration manifest + collab-file crypto must be byte-for-byte
 * interoperable with the Dart app, the pinning-webui TS portal, and the Rust
 * `fula-mcp` (`crates/fula-mcp/src/manifest.rs`). This suite:
 *   1. ENCRYPTS in TS and asserts the on-wire LAYOUT: `nonce(12) || ct || tag(16)`
 *      for a collab file, and `"ENC1:" + base64_standard(nonce||ct||tag)` for the
 *      manifest envelope (the exact spec the other three implement);
 *   2. cross-checks against VANILLA WebCrypto HKDF-SHA256 (empty salt) +
 *      AES-256-GCM — the same primitives Dart/Rust use — by deriving the key an
 *      INDEPENDENT way and decrypting our ciphertext with it (and vice-versa). If
 *      a foreign key+AEAD interoperates, our derivation + layout match the wire
 *      spec the other implementations follow.
 */

import { describe, it, expect } from "vitest";
import {
  enc1Encrypt,
  enc1Decrypt,
  collabFileEncrypt,
  collabFileDecrypt,
  base64StdDecode,
  ENC1_PREFIX,
  CollabCryptoError,
} from "../src/fula/collab/crypto.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** An INDEPENDENT HKDF-SHA256 (empty salt) → raw 32-byte key, via crypto.subtle
 *  deriveBits — deliberately NOT our module, so interop proves we match the spec. */
async function vanillaHkdfKeyBytes(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function vanillaAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Vanilla AES-256-GCM open of `nonce(12)||ct||tag` with the given raw key. */
async function vanillaOpen(rawKey: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const key = await vanillaAesKey(rawKey);
  const nonce = blob.subarray(0, 12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, blob.subarray(12));
  return new Uint8Array(pt);
}

const LINK_SECRET = new Uint8Array(32);
for (let i = 0; i < 32; i++) LINK_SECRET[i] = (i * 7 + 3) & 0xff;
const GROUP_ID = "1b9d7c2e-0000-4000-8000-000000000abc";

describe("collab-file crypto — layout + cross-impl parity", () => {
  it("collabFileEncrypt emits nonce(12) || ciphertext || tag(16)", async () => {
    const plaintext = enc.encode("hello collab payload ☕");
    const fileId = "f1a2b3c4-0000-4000-8000-0000000000aa";
    const blob = await collabFileEncrypt(plaintext, LINK_SECRET, fileId);
    // nonce(12) + ciphertext(== plaintext length, GCM is a stream cipher) + tag(16)
    expect(blob.length).toBe(12 + plaintext.length + 16);
    // Round-trips through our own decrypt.
    const back = await collabFileDecrypt(blob, LINK_SECRET, fileId);
    expect(dec.decode(back)).toBe("hello collab payload ☕");
  });

  it("our ciphertext decrypts under a VANILLA HKDF-derived key (parity)", async () => {
    const plaintext = enc.encode("cross-impl parity check");
    const fileId = "f1a2b3c4-0000-4000-8000-0000000000bb";
    const blob = await collabFileEncrypt(plaintext, LINK_SECRET, fileId);

    // Derive the SAME per-file key the independent way (HKDF info collab-file-v1:{id}).
    const rawKey = await vanillaHkdfKeyBytes(LINK_SECRET, `collab-file-v1:${fileId}`);
    const recovered = await vanillaOpen(rawKey, blob);
    expect(dec.decode(recovered)).toBe("cross-impl parity check");
  });

  it("a wrong fileId derives a different key and fails to decrypt (authenticated)", async () => {
    const blob = await collabFileEncrypt(enc.encode("x"), LINK_SECRET, "id-correct-0000-4000-8000-00000000aaaa");
    await expect(collabFileDecrypt(blob, LINK_SECRET, "id-wrong-0000-4000-8000-00000000bbbb")).rejects.toBeInstanceOf(
      CollabCryptoError,
    );
  });
});

describe("manifest ENC1 envelope — layout + round-trip + parity", () => {
  it('enc1Encrypt → "ENC1:" + base64(nonce||ct||tag), decodes to the right length', async () => {
    const manifestJson = enc.encode('{"id":"g","files":[]}');
    const wire = await enc1Encrypt(manifestJson, LINK_SECRET, GROUP_ID);
    expect(wire.startsWith(ENC1_PREFIX)).toBe(true);
    const blob = base64StdDecode(wire.slice(ENC1_PREFIX.length));
    expect(blob.length).toBe(12 + manifestJson.length + 16);
  });

  it("round-trips through enc1Decrypt", async () => {
    const manifestJson = enc.encode('{"id":"group","name":"N","files":[{"id":"x"}]}');
    const wire = await enc1Encrypt(manifestJson, LINK_SECRET, GROUP_ID);
    const back = await enc1Decrypt(wire, LINK_SECRET, GROUP_ID);
    expect(dec.decode(back)).toBe('{"id":"group","name":"N","files":[{"id":"x"}]}');
  });

  it("the ENC1 body decrypts under a VANILLA manifest-enc-v1 HKDF key (parity)", async () => {
    const manifestJson = enc.encode('{"v":1}');
    const wire = await enc1Encrypt(manifestJson, LINK_SECRET, GROUP_ID);
    const blob = base64StdDecode(wire.slice(ENC1_PREFIX.length));
    const rawKey = await vanillaHkdfKeyBytes(LINK_SECRET, `manifest-enc-v1:${GROUP_ID}`);
    const recovered = await vanillaOpen(rawKey, blob);
    expect(dec.decode(recovered)).toBe('{"v":1}');
  });

  it("the manifest key is domain-separated from the per-file key (different info)", async () => {
    // The same secret + same id string must NOT yield the same key for the two
    // domains (manifest-enc-v1: vs collab-file-v1:) — a foreign-domain key must fail.
    const id = GROUP_ID;
    const manifestKeyBytes = await vanillaHkdfKeyBytes(LINK_SECRET, `manifest-enc-v1:${id}`);
    const fileKeyBytes = await vanillaHkdfKeyBytes(LINK_SECRET, `collab-file-v1:${id}`);
    expect(hex(manifestKeyBytes)).not.toBe(hex(fileKeyBytes));

    // A collab-file blob must not open under the manifest key.
    const blob = await collabFileEncrypt(enc.encode("payload"), LINK_SECRET, id);
    await expect(vanillaOpen(manifestKeyBytes, blob)).rejects.toBeTruthy();
  });

  it("rejects a non-ENC1 envelope and a wrong scope", async () => {
    await expect(enc1Decrypt("not-enc1", LINK_SECRET, GROUP_ID)).rejects.toBeInstanceOf(CollabCryptoError);
    const wire = await enc1Encrypt(enc.encode("{}"), LINK_SECRET, GROUP_ID);
    // Wrong groupId → wrong manifest key → auth failure.
    await expect(enc1Decrypt(wire, LINK_SECRET, "different-group-id")).rejects.toBeInstanceOf(CollabCryptoError);
  });
});

describe("deterministic AES-256-GCM vector (cross-language reproduction anchor)", () => {
  // A FIXED key + FIXED nonce + FIXED plaintext yields a deterministic
  // `nonce||ct||tag` — any Dart/Rust impl with the same inputs produces the same
  // bytes. We rebuild the blob with raw crypto.subtle (fixed iv) and assert our
  // collabFileDecrypt path can open the SAME layout a foreign producer would emit.
  it("our decrypt opens a foreign-built nonce(12)||ct||tag blob for a known per-file key", async () => {
    const fileId = "deadbeef-0000-4000-8000-00000000cafe";
    const plaintext = enc.encode("the quick brown fox");
    // Foreign producer: derive the per-file key the vanilla way, encrypt with a
    // FIXED nonce, assemble nonce||ct||tag.
    const rawKey = await vanillaHkdfKeyBytes(LINK_SECRET, `collab-file-v1:${fileId}`);
    const key = await vanillaAesKey(rawKey);
    const nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));
    const foreignBlob = new Uint8Array(12 + ctTag.length);
    foreignBlob.set(nonce, 0);
    foreignBlob.set(ctTag, 12);

    // Our module decrypts the foreign producer's exact wire layout.
    const back = await collabFileDecrypt(foreignBlob, LINK_SECRET, fileId);
    expect(dec.decode(back)).toBe("the quick brown fox");
  });
});
