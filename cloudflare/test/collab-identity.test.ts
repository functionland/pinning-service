/**
 * MCP identity — `FULA-` id encode/decode (Dart/Rust golden) + the HPKE
 * link-secret UNWRAP seam (./identity.ts `recoverLinkSecret`). Runs inside
 * workerd because it uses the fula WASM HPKE primitives.
 *
 * The unwrap seam is the FLAGGED upstream dependency (see ./identity.ts + the PR
 * notes): the pinned WASM can unwrap a BARE HPKE envelope (`testHpkeEncryptDek`
 * format) but NOT a v5 ShareToken (the Rust/local-MCP contract — no DEK-returning
 * binding). This suite pins both: the bare-envelope round-trip works, and a v5
 * ShareToken is rejected with the precise "needs a fula-client binding" error.
 */

import { describe, it, expect } from "vitest";
import {
  encodeFulaId,
  decodeFulaId,
  publicKeyFromSecret,
  publicKeyB64,
  recoverLinkSecret,
  IdentityError,
} from "../src/fula/collab/identity.js";
import { blake3DeriveKey, derivePublicKeyFromSecret, testHpkeEncryptDek } from "../src/fula/wasm.js";

function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("FULA- identity string (Dart/Rust golden vector)", () => {
  it("encodes 0x00..0x1f to the exact Dart `encodeFulaShareId` answer", () => {
    const pk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pk[i] = i;
    // Captured from the Rust `encode_fula_id` known-answer test (= Dart).
    expect(encodeFulaId(pk)).toBe("FULA-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  });

  it("decodes a FULA- id (and a bare / lowercase-prefixed key) back to the pubkey", () => {
    const pk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pk[i] = i;
    const id = encodeFulaId(pk);
    expect(hex(decodeFulaId(id))).toBe(hex(pk));
    expect(hex(decodeFulaId("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"))).toBe(hex(pk));
    expect(hex(decodeFulaId("fula-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"))).toBe(hex(pk));
  });

  it("publicKeyFromSecret + publicKeyB64 agree with the WASM derivation", () => {
    const secret = blake3DeriveKey("test:mcp-identity:v1", new Uint8Array(32).fill(9));
    const pub = publicKeyFromSecret(secret);
    expect(pub.length).toBe(32);
    expect(hex(pub)).toBe(hex(derivePublicKeyFromSecret(secret)));
    // publicKeyB64 decodes back to the same 32 bytes.
    const b64 = publicKeyB64(pub);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(hex(back)).toBe(hex(pub));
  });
});

describe("recoverLinkSecret — the HPKE unwrap seam", () => {
  it("recovers a link secret wrapped as a BARE HPKE envelope (pinned-WASM path)", () => {
    const workerSecret = blake3DeriveKey("test:worker:v1", new Uint8Array(32).fill(1));
    const workerPub = derivePublicKeyFromSecret(workerSecret);

    const linkSecret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) linkSecret[i] = (i * 11 + 5) & 0xff;

    // FxFiles (the producer) wraps the link secret (a 32-byte DEK) to the worker pubkey.
    const wrapped = testHpkeEncryptDek(workerPub, linkSecret);
    // It is a bare envelope (has encapsulated_key + ciphertext, no wrapped_key).
    const env = JSON.parse(wrapped);
    expect(env.wrapped_key).toBeUndefined();
    expect(env.encapsulated_key).toBeTruthy();

    const recovered = recoverLinkSecret(workerSecret, wrapped);
    expect(hex(recovered)).toBe(hex(linkSecret));
  });

  it("a STRANGER worker key cannot recover the link secret", () => {
    const workerPub = derivePublicKeyFromSecret(blake3DeriveKey("test:worker:v1", new Uint8Array(32).fill(1)));
    const stranger = blake3DeriveKey("test:stranger:v1", new Uint8Array(32).fill(2));
    const wrapped = testHpkeEncryptDek(workerPub, new Uint8Array(32).fill(7));
    expect(() => recoverLinkSecret(stranger, wrapped)).toThrow(IdentityError);
  });

  it("a v5 ShareToken surfaces the precise upstream-binding dependency (not a silent fail)", () => {
    const workerSecret = blake3DeriveKey("test:worker:v1", new Uint8Array(32).fill(1));
    // A v5 ShareToken carries `wrapped_key` + `version` — the Rust/local-MCP contract.
    const shareToken = JSON.stringify({
      id: "share-1",
      wrapped_key: { version: 5, encapsulated_key: { ephemeral_public: [] }, ciphertext: "..." },
      path_scope: "/collab/g",
      version: 5,
    });
    try {
      recoverLinkSecret(workerSecret, shareToken);
      throw new Error("expected recoverLinkSecret to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityError);
      expect((e as IdentityError).kind).toBe("unsupportedShareToken");
      expect((e as IdentityError).message).toContain("acceptShareDek");
    }
  });
});
