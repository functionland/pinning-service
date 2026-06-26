/**
 * WASM crypto round-trip + format-fidelity (H3) — runs INSIDE workerd.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This is the fidelity proof that does NOT need the gateway (the task's required
 * "WASM crypto round-trip (must pass)"). It proves:
 *
 *   1. The `@functionland/fula-client` WASM initializes in the Worker isolate via
 *      a CompiledWasm import + `initSync` (the H3 glue approach).
 *   2. The package is PINNED to the SAME version FxFiles uses (0.6.16) — version
 *      drift is exactly where the on-disk envelope/metadata format can diverge.
 *   3. The AI-workspace-secret derivation (`blake3DeriveKey('fula:ai-workspace-
 *      secret:v1', KEK)`) is byte-stable (golden vector) — a change in this
 *      derivation would silently break interop with FxFiles' workspace client.
 *   4. The crypto building blocks FxFiles' format is made of round-trip exactly:
 *      HPKE DEK-wrap → unwrap, AES-256-GCM encrypt → decrypt, and the full
 *      derive→HPKE→AES path (`testFullEncryptionRoundtrip`). These are the SAME
 *      primitives (same WASM build) the FxFiles app encrypts/decrypts with, so a
 *      successful round-trip here is a format-parity signal: bytes wrapped by this
 *      build unwrap by this build, and (because it is the same build FxFiles ships
 *      at 0.6.16) by FxFiles' client too.
 *
 * NOTE on "byte-identical": HPKE/AES use RANDOM nonces/encapsulations, so two
 * encryptions of the same input are NOT identical bytes (advisor: Codex). Fidelity
 * is therefore "FxFiles-COMPATIBLE" (decryptable across the same build/config), not
 * deterministic byte-equality. The deterministic pieces (the BLAKE3 key
 * derivation) ARE asserted byte-for-byte below.
 *
 * The FULL store→read round-trip against the REAL gateway (s3.cloud.fx.land) is
 * deferred to H4 — see the report. It needs a real scoped token + workspace
 * secret plumbed from the e2e creds, which is not available from a local test.
 */

import { describe, it, expect } from "vitest";
import {
  ensureWasmReady,
  getVersion,
  PINNED_FULA_CLIENT_VERSION,
  blake3DeriveKey,
  derivePublicKeyFromSecret,
  testHpkeEncryptDek,
  testHpkeDecryptDek,
  testAesGcmEncrypt,
  testAesGcmDecrypt,
  testFullEncryptionRoundtrip,
  createEncryptedClient,
  freeClient,
} from "../src/fula/wasm.js";

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
const enc = new TextEncoder();
const dec = new TextDecoder();

/** KEK = bytes 0x00..0x1f — the fixture seed for the golden derivation vector. */
function fixtureKek(): Uint8Array {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = i;
  return k;
}

describe("fula-client WASM — init + version pin", () => {
  it("initializes in workerd via the CompiledWasm import (initSync)", () => {
    ensureWasmReady(); // must not throw inside the isolate
    expect(typeof getVersion()).toBe("string");
  });

  it("is pinned to the SAME version FxFiles ships (byte-format parity guard)", () => {
    // FxFiles uses `fula_client ^0.6.17`; if these ever diverge, the on-disk
    // envelope/metadata format may differ silently — fail loudly here instead.
    expect(getVersion()).toBe(PINNED_FULA_CLIENT_VERSION);
    expect(getVersion()).toBe("0.6.17");
  });
});

describe("AI-workspace-secret derivation — golden vector (FxFiles parity)", () => {
  // FxFiles derives the workspace secret as:
  //   blake3DeriveKey('fula:ai-workspace-secret:v1', KEK)
  // (ai_connection_service.dart). This vector pins the exact 32 bytes for a known
  // KEK so a change in the derivation (algorithm, context, or KEK handling) is
  // caught even at the same package version.
  const GOLDEN_WS_SECRET =
    "9a898da56fd236561a1ded1493109e368ca659e58ee490969047129c4d407ef8";

  it("matches the golden 32-byte workspace secret for KEK=00..1f", () => {
    const ws = blake3DeriveKey("fula:ai-workspace-secret:v1", fixtureKek());
    expect(ws.length).toBe(32);
    expect(hex(ws)).toBe(GOLDEN_WS_SECRET);
  });

  it("is deterministic (same KEK+context → same secret)", () => {
    const a = blake3DeriveKey("fula:ai-workspace-secret:v1", fixtureKek());
    const b = blake3DeriveKey("fula:ai-workspace-secret:v1", fixtureKek());
    expect(hex(a)).toBe(hex(b));
  });

  it("is domain-separated (a different context yields a different secret)", () => {
    const a = blake3DeriveKey("fula:ai-workspace-secret:v1", fixtureKek());
    const b = blake3DeriveKey("fula:some-other-context:v1", fixtureKek());
    expect(hex(a)).not.toBe(hex(b));
  });
});

describe("crypto building blocks round-trip (the format primitives)", () => {
  it("HPKE: wrap a DEK to the workspace pubkey, unwrap with the secret → same DEK", () => {
    const ws = blake3DeriveKey("fula:ai-workspace-secret:v1", fixtureKek());
    const pub = derivePublicKeyFromSecret(ws);
    expect(pub.length).toBe(32);

    const dek = new Uint8Array(32);
    for (let i = 0; i < 32; i++) dek[i] = (i * 7) & 0xff;

    const wrappedJson = testHpkeEncryptDek(pub, dek);
    // The wrapped DEK is the `{ version, encapsulated_key, ciphertext }` envelope
    // FxFiles stores as `wrapped_key` — assert it parses to that shape.
    const wrapped = JSON.parse(wrappedJson) as Record<string, unknown>;
    expect(wrapped).toHaveProperty("encapsulated_key");
    expect(wrapped).toHaveProperty("ciphertext");

    const recovered = testHpkeDecryptDek(ws, wrappedJson);
    expect(hex(recovered)).toBe(hex(dek));
  });

  it("HPKE: a STRANGER key cannot unwrap the DEK", () => {
    const ws = blake3DeriveKey("fula:ai-workspace-secret:v1", fixtureKek());
    const pub = derivePublicKeyFromSecret(ws);
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const wrappedJson = testHpkeEncryptDek(pub, dek);

    const stranger = crypto.getRandomValues(new Uint8Array(32));
    expect(() => testHpkeDecryptDek(stranger, wrappedJson)).toThrow();
  });

  it("AES-256-GCM: encrypt then decrypt with the same DEK → exact plaintext", () => {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = enc.encode("the quick brown fox jumps over the lazy dog");
    const out = JSON.parse(testAesGcmEncrypt(dek, plaintext)) as {
      nonce: string;
      ciphertext: string;
    };
    expect(typeof out.nonce).toBe("string");
    expect(typeof out.ciphertext).toBe("string");
    const back = testAesGcmDecrypt(dek, out.nonce, out.ciphertext);
    expect(dec.decode(back)).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("AES-256-GCM: a WRONG DEK fails to decrypt (authenticated)", () => {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const out = JSON.parse(testAesGcmEncrypt(dek, enc.encode("secret"))) as {
      nonce: string;
      ciphertext: string;
    };
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    expect(() => testAesGcmDecrypt(wrong, out.nonce, out.ciphertext)).toThrow();
  });

  it("AES-256-GCM: random nonces ⇒ ciphertext is NOT deterministic (by design)", () => {
    // This is WHY fidelity is 'compatible', not 'byte-identical': encrypting the
    // same plaintext twice yields different bytes. Both must still decrypt.
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const pt = enc.encode("same input, different ciphertext");
    const a = JSON.parse(testAesGcmEncrypt(dek, pt)) as { nonce: string; ciphertext: string };
    const b = JSON.parse(testAesGcmEncrypt(dek, pt)) as { nonce: string; ciphertext: string };
    expect(a.ciphertext === b.ciphertext && a.nonce === b.nonce).toBe(false);
    expect(dec.decode(testAesGcmDecrypt(dek, a.nonce, a.ciphertext))).toBe(
      "same input, different ciphertext",
    );
    expect(dec.decode(testAesGcmDecrypt(dek, b.nonce, b.ciphertext))).toBe(
      "same input, different ciphertext",
    );
  });

  it("FULL path: derive→HPKE-wrap→AES-encrypt then reverse → exact plaintext", () => {
    // testFullEncryptionRoundtrip exercises the EXACT flow the SDK uses end to
    // end (the comment in the .d.ts: 'If this works, the WASM crypto is correct.')
    const plaintext = enc.encode("a file the AI stored, recovered byte-for-byte ✓");
    const recovered = testFullEncryptionRoundtrip(
      "fula-files-v1",
      enc.encode("google:test-sub:user@example.com"),
      plaintext,
    );
    expect(Array.from(recovered)).toEqual(Array.from(plaintext));
  });
});

describe("workspace EncryptedClient construction — FxFiles-identical config", () => {
  it("accepts the EXACT workspace config FxFiles uses (metadata-privacy + flatNamespace)", async () => {
    // We can build the client offline (no network until a put/get). The point is
    // to prove the config shape FxFiles' _buildWorkspaceClient uses is accepted
    // verbatim by the hosted client, so the on-the-wire behavior matches.
    const ws = blake3DeriveKey("fula:ai-workspace-secret:v1", fixtureKek());
    const client = await createEncryptedClient(
      { endpoint: "https://offline.invalid", accessToken: "offline-jwt" },
      { secretKey: ws, obfuscationMode: "flatNamespace", enableMetadataPrivacy: true },
    );
    expect(client).toBeTruthy();
    freeClient(client);
  });
});
