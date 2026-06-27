/**
 * MCP identity — `FULA-` id encode/decode (Dart/Rust golden) + the HPKE
 * link-secret UNWRAP seam (./identity.ts `recoverLinkSecret`). Runs inside
 * workerd because it uses the fula WASM HPKE primitives.
 *
 * The unwrap seam (fula-client 0.6.19) unwraps the PRODUCTION v5 ShareToken (the
 * Rust/local-MCP + FxFiles contract) directly via `unwrapSecretForRecipient`. This
 * suite pins the v5 round-trip (wrap → recover the exact link secret), the
 * stranger-key rejection, and the gated bare-envelope TEST affordance.
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
import {
  blake3DeriveKey,
  derivePublicKeyFromSecret,
  testHpkeEncryptDek,
  wrapSecretForRecipient,
} from "../src/fula/wasm.js";

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

    // Bare-envelope is GATED: the live path is fail-closed v5-only, so without
    // an explicit opt-in this rejects (asserted below); only tests opt in.
    expect(() => recoverLinkSecret(workerSecret, wrapped)).toThrow(IdentityError);
    const recovered = recoverLinkSecret(workerSecret, wrapped, { allowBareEnvelope: true });
    expect(hex(recovered)).toBe(hex(linkSecret));
  });

  it("the bare-envelope path is disabled on the live path (fail-closed v5-only)", () => {
    const workerSecret = blake3DeriveKey("test:worker:v1", new Uint8Array(32).fill(1));
    const workerPub = derivePublicKeyFromSecret(workerSecret);
    const wrapped = testHpkeEncryptDek(workerPub, new Uint8Array(32).fill(7));
    try {
      recoverLinkSecret(workerSecret, wrapped); // no allowBareEnvelope ⇒ rejected
      throw new Error("expected recoverLinkSecret to reject the bare envelope");
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityError);
      expect((e as IdentityError).kind).toBe("unsupportedShareToken");
    }
  });

  it("a STRANGER worker key cannot recover the link secret", () => {
    const workerPub = derivePublicKeyFromSecret(blake3DeriveKey("test:worker:v1", new Uint8Array(32).fill(1)));
    const stranger = blake3DeriveKey("test:stranger:v1", new Uint8Array(32).fill(2));
    const wrapped = testHpkeEncryptDek(workerPub, new Uint8Array(32).fill(7));
    expect(() => recoverLinkSecret(stranger, wrapped, { allowBareEnvelope: true })).toThrow(IdentityError);
  });

  it("recovers a link secret wrapped as a v5 ShareToken (the production Method-2 path)", () => {
    const workerSecret = blake3DeriveKey("test:worker:v1", new Uint8Array(32).fill(1));
    const workerPub = derivePublicKeyFromSecret(workerSecret);

    const linkSecret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) linkSecret[i] = (i * 7 + 3) & 0xff;

    // FxFiles (the producer) HPKE-wraps the link secret to the worker pubkey as a v5 ShareToken.
    const token = wrapSecretForRecipient(linkSecret, workerPub, "/collab/g", 3600n);
    const parsed = JSON.parse(token);
    expect(parsed.wrapped_key).toBeTruthy(); // it IS a v5 ShareToken
    expect(parsed.version).toBe(5);

    // recoverLinkSecret unwraps it directly on the LIVE path (no allowBareEnvelope needed).
    const recovered = recoverLinkSecret(workerSecret, token);
    expect(hex(recovered)).toBe(hex(linkSecret));
  });

  it("a v5 ShareToken addressed to a STRANGER fails closed", () => {
    const workerSecret = blake3DeriveKey("test:worker:v1", new Uint8Array(32).fill(1));
    const strangerPub = derivePublicKeyFromSecret(
      blake3DeriveKey("test:stranger:v1", new Uint8Array(32).fill(2)),
    );
    // Wrapped for the stranger, not the worker → accept_share fails → IdentityError("share").
    const token = wrapSecretForRecipient(new Uint8Array(32).fill(9), strangerPub, "/collab/g", 3600n);
    try {
      recoverLinkSecret(workerSecret, token);
      throw new Error("expected recoverLinkSecret to reject a token addressed to a stranger");
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityError);
      expect((e as IdentityError).kind).toBe("share");
    }
  });
});
