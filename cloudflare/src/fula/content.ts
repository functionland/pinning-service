/**
 * Binary-safe content encode/decode for MCP tool payloads (H3).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * MCP serializes tool arguments as JSON, so file bytes must arrive as a STRING.
 * Accepting a bare string and UTF-8-encoding it would SILENTLY CORRUPT binary
 * data (NUL bytes, invalid UTF-8, image magic bytes…). So `fula_store_file`
 * REQUIRES an explicit `encoding` discriminator (advisor-mandated — Codex +
 * Cursor):
 *   • "utf8"   → the content is text; encode with TextEncoder.
 *   • "base64" → the content is base64-encoded binary; strict-decode.
 *
 * Size is capped on the DECODED byte length (base64 inflates ~4/3), well under
 * the Worker isolate's 128 MB so the plaintext + ciphertext + WASM heap copies
 * all fit. Above the cap we fail with a clear, actionable error (the streaming
 * upload path is not exposed by the JS client — see the tools' size note).
 */

export type ContentEncoding = "utf8" | "base64";

/** Max DECODED size for a single buffered store (conservative for a 128 MB isolate). */
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024; // 25 MiB

export class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentError";
  }
}

/** Decode a tool `content` string into bytes per `encoding`, enforcing the cap. */
export function decodeContent(content: string, encoding: ContentEncoding): Uint8Array {
  if (encoding === "utf8") {
    const bytes = new TextEncoder().encode(content);
    enforceCap(bytes.length);
    return bytes;
  }
  // base64 — estimate decoded size BEFORE allocating, then strict-decode.
  const approx = Math.floor((content.length * 3) / 4);
  enforceCap(approx);
  return base64Decode(content);
}

/** Encode bytes back to a tool-result string per `encoding` (read path). */
export function encodeContent(bytes: Uint8Array, encoding: ContentEncoding): string {
  if (encoding === "utf8") {
    // fatal: true → throws if the bytes are not valid UTF-8 (caller asked for text).
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  }
  return base64Encode(bytes);
}

function enforceCap(n: number): void {
  if (n > MAX_CONTENT_BYTES) {
    throw new ContentError(
      `content exceeds the ${Math.floor(MAX_CONTENT_BYTES / (1024 * 1024))} MiB limit for the hosted MCP ` +
        `(buffered upload; large-file streaming is not available in the hosted client — ` +
        `use the FxFiles app for large files).`,
    );
  }
}

// ── base64 (standard alphabet; strict) ───────────────────────────────────────
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function base64Decode(s: string): Uint8Array {
  // Reject anything that is not canonical standard base64 (no whitespace, no
  // url-safe chars) so we never silently mangle binary input.
  if (!B64_RE.test(s) || s.length % 4 !== 0) {
    throw new ContentError("content is not valid standard base64");
  }
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new ContentError("content is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  enforceCap(out.length);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  // Chunk to avoid blowing the call-stack on String.fromCharCode(...spread).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
