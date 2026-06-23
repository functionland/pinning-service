/**
 * Fula client WASM bootstrap for Cloudflare Workers (H3).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * We use `@functionland/fula-client` — the SAME wasm-bindgen build of the Rust
 * `fula-js`/`fula-client`/`fula-crypto` stack that the FxFiles app uses — so the
 * Worker reads/writes the AI-workspace forest in a format FxFiles' own client can
 * decrypt. The npm package is PINNED to 0.6.16 to match FxFiles' native
 * `fula_client ^0.6.16` (see package.json + the version assertion in the tests).
 *
 * WASM-IN-WORKER GLUE (advisor-reviewed — Codex GPT-5.5 + Cursor; empirically
 * proven by the crypto round-trip test):
 *   • The package ships a wasm-bindgen `--target web` bundle: `fula_js.js` (glue)
 *     + `fula_js_bg.wasm`. The glue's DEFAULT `__wbg_init()` resolves the wasm via
 *     `new URL('fula_js_bg.wasm', import.meta.url)` + `fetch` — fragile under
 *     Workers bundling. We DO NOT use it.
 *   • Instead we import the `.wasm` as a Cloudflare **CompiledWasm** module
 *     (`import wasmModule from "….wasm"` → a `WebAssembly.Module`; wrangler/esbuild
 *     bundles it natively) and call `initSync({ module: wasmModule })` ONCE at
 *     module-evaluation time. `initSync` is the supported public API: it wires the
 *     imports and runs `__wbindgen_start`. We deliberately prefer it over poking
 *     `__wbg_set_wasm` (which would skip wasm-bindgen's start semantics).
 *   • Everything the glue needs at runtime exists in Workers: the global `fetch`
 *     (the client's gateway HTTP), `TextEncoder`/`TextDecoder`, `WebAssembly.*`,
 *     and `FinalizationRegistry` (used for GC of WASM handles — but we ALSO free
 *     handles explicitly; we never rely on the finalizer for secret hygiene).
 *
 * Module-level init runs once per isolate (idempotent: the glue's `initSync`
 * early-returns if `wasm` is already set), so the ~2.1 MB module is compiled once
 * and every request reuses it.
 */

// The Cloudflare CompiledWasm import. wrangler/esbuild + @cloudflare/vitest-pool-
// workers turn this into a `WebAssembly.Module`. (Type-only: see fula-wasm.d.ts.)
import wasmModule from "@functionland/fula-client/fula_js_bg.wasm";
import {
  initSync,
  createEncryptedClient as _createEncryptedClient,
  putEncryptedWithType as _putEncryptedWithType,
  getDecrypted as _getDecrypted,
  listDecrypted as _listDecrypted,
  deleteEncrypted as _deleteEncrypted,
  blake3DeriveKey as _blake3DeriveKey,
  derivePublicKeyFromSecret as _derivePublicKeyFromSecret,
  getVersion as _getVersion,
  testFullEncryptionRoundtrip as _testFullEncryptionRoundtrip,
  testHpkeEncryptDek as _testHpkeEncryptDek,
  testHpkeDecryptDek as _testHpkeDecryptDek,
  testAesGcmEncrypt as _testAesGcmEncrypt,
  testAesGcmDecrypt as _testAesGcmDecrypt,
  type EncryptedClient,
} from "@functionland/fula-client";

/** The npm version we pin to (asserted against the running WASM in tests). */
export const PINNED_FULA_CLIENT_VERSION = "0.6.16";

let initialized = false;

/** Initialize the WASM module exactly once per isolate. Idempotent + cheap. */
export function ensureWasmReady(): void {
  if (initialized) return;
  // Object form avoids the deprecation warning emitted by the bare-arg path.
  initSync({ module: wasmModule as WebAssembly.Module });
  initialized = true;
}

// ── Typed re-exports ─────────────────────────────────────────────────────────
// The package's .d.ts types `config`/`encryption`/`options`/results as `any`.
// We wrap them with precise types so callers get checked shapes, and we call
// `ensureWasmReady()` on the entry points that need the module live.

/** `createEncryptedClient` config — mirrors fula-js `JsFulaConfig`. */
export interface FulaConfig {
  endpoint: string;
  accessToken?: string;
}

/**
 * `createEncryptedClient` encryption config — mirrors fula-js `JsEncryptionConfig`.
 * For FxFiles-COMPATIBLE objects the AI-workspace client MUST set
 * `enableMetadataPrivacy: true` AND `obfuscationMode: 'flatNamespace'` (this is
 * exactly how FxFiles builds its workspace client — see fula_api_service.dart
 * `_buildWorkspaceClient`). Omitting metadata privacy yields a different
 * metadata/listing shape than FxFiles writes.
 */
export interface FulaEncryptionConfig {
  /** 32-byte workspace secret (= blake3DeriveKey('fula:ai-workspace-secret:v1', KEK)). */
  secretKey: Uint8Array;
  obfuscationMode: "flatNamespace" | "deterministic" | "random" | "preserveStructure";
  enableMetadataPrivacy: boolean;
}

/** Result of an encrypted PUT. */
export interface PutResult {
  etag?: string;
  versionId?: string;
  [k: string]: unknown;
}

/** One row from `listDecrypted`. */
export interface FileMetadata {
  storageKey?: string;
  originalKey?: string;
  size?: number;
  contentType?: string;
  createdAt?: number;
  modifiedAt?: number;
  isEncrypted?: boolean;
  [k: string]: unknown;
}

export type { EncryptedClient };

export async function createEncryptedClient(
  config: FulaConfig,
  encryption: FulaEncryptionConfig,
): Promise<EncryptedClient> {
  ensureWasmReady();
  return _createEncryptedClient(config, encryption);
}

export function putEncryptedWithType(
  client: EncryptedClient,
  bucket: string,
  key: string,
  data: Uint8Array,
  contentType: string,
): Promise<PutResult> {
  return _putEncryptedWithType(client, bucket, key, data, contentType);
}

export function getDecrypted(
  client: EncryptedClient,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  return _getDecrypted(client, bucket, key);
}

export function listDecrypted(
  client: EncryptedClient,
  bucket: string,
  options: { prefix?: string; maxKeys?: number } = {},
): Promise<FileMetadata[]> {
  return _listDecrypted(client, bucket, options) as Promise<FileMetadata[]>;
}

export function deleteEncrypted(
  client: EncryptedClient,
  bucket: string,
  key: string,
): Promise<void> {
  return _deleteEncrypted(client, bucket, key);
}

/** BLAKE3 keyed sub-key derivation (the AI-workspace-secret derivation primitive). */
export function blake3DeriveKey(context: string, input: Uint8Array): Uint8Array {
  ensureWasmReady();
  return _blake3DeriveKey(context, input);
}

/** X25519 public key from a 32-byte secret. */
export function derivePublicKeyFromSecret(secret: Uint8Array): Uint8Array {
  ensureWasmReady();
  return _derivePublicKeyFromSecret(secret);
}

export function getVersion(): string {
  ensureWasmReady();
  return _getVersion();
}

// ── Pure crypto test helpers (no network) — used by the fidelity tests ───────
export function testFullEncryptionRoundtrip(
  context: string,
  input: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  ensureWasmReady();
  return _testFullEncryptionRoundtrip(context, input, plaintext);
}
export function testHpkeEncryptDek(publicKey: Uint8Array, dek: Uint8Array): string {
  ensureWasmReady();
  return _testHpkeEncryptDek(publicKey, dek);
}
export function testHpkeDecryptDek(secretKey: Uint8Array, wrappedDekJson: string): Uint8Array {
  ensureWasmReady();
  return _testHpkeDecryptDek(secretKey, wrappedDekJson);
}
export function testAesGcmEncrypt(dek: Uint8Array, plaintext: Uint8Array): string {
  ensureWasmReady();
  return _testAesGcmEncrypt(dek, plaintext);
}
export function testAesGcmDecrypt(
  dek: Uint8Array,
  nonceB64: string,
  ciphertextB64: string,
): Uint8Array {
  ensureWasmReady();
  return _testAesGcmDecrypt(dek, nonceB64, ciphertextB64);
}

/** Free a client handle's WASM-side memory. Best-effort + idempotent. */
export function freeClient(client: EncryptedClient | null | undefined): void {
  try {
    (client as unknown as { free?: () => void })?.free?.();
  } catch {
    // already freed / no-op
  }
}
