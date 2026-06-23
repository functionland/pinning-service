/**
 * Workspace key construction + minimal category classification (H3).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ports the load-bearing pieces of the local Rust `fula-mcp` `store.rs` contract:
 *   • Bucket            = "fula-ai-workspace"
 *   • Logical key shape = "ai/<category>/<uuid>-<safe-filename>"
 *   • Filename sanitize = ASCII allowlist [A-Za-z0-9._-], basename only, capped.
 *
 * The category set + names match the Rust `Category` enum (so keys land under the
 * same `ai/<name>/` prefixes FxFiles adopts). Per the advisor review (Codex +
 * Cursor) we DO NOT port the full Rust mime/text classifier for H3 — a light
 * extension/mime heuristic is enough, because FxFiles interop depends on the
 * encryption config + key namespace, not on matching the exact heuristic. The
 * default category is `other` (the Rust default), and the caller may override.
 */

export const WORKSPACE_BUCKET = "fula-ai-workspace";
export const WORKSPACE_KEY_PREFIX = "ai";

/** The category names — identical strings to the Rust `Category::name()`. */
export const CATEGORIES = [
  "image",
  "screenshot",
  "video",
  "audio",
  "document",
  "note",
  "link",
  "file",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

const MAX_FILENAME_SEGMENT_LEN = 96;

const EXT_TO_CATEGORY: Record<string, Category> = {
  // images
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  heic: "image", bmp: "image", svg: "image", tiff: "image",
  // video
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video", m4v: "video",
  // audio
  mp3: "audio", wav: "audio", flac: "audio", aac: "audio", ogg: "audio", m4a: "audio",
  // documents
  pdf: "document", doc: "document", docx: "document", xls: "document", xlsx: "document",
  ppt: "document", pptx: "document", csv: "document", rtf: "document", odt: "document",
  // notes (plain text)
  txt: "note", md: "note", markdown: "note",
};

const MIME_PREFIX_TO_CATEGORY: Array<[string, Category]> = [
  ["image/", "image"],
  ["video/", "video"],
  ["audio/", "audio"],
];

/**
 * Classify a file into a workspace category from (mime, filename, text).
 * Precedence: explicit text payload → Note; mime prefix; filename extension;
 * else `other`. Deliberately small; callers may override.
 */
export function classify(
  mime: string | undefined,
  filename: string | undefined,
  text: string | undefined,
): Category {
  if (text && text.trim().length > 0 && !filename && !mime) {
    // A pure text payload with no file → a note (matches the Rust Note bias).
    return "note";
  }
  if (mime) {
    const m = mime.toLowerCase();
    for (const [prefix, cat] of MIME_PREFIX_TO_CATEGORY) {
      if (m.startsWith(prefix)) return cat;
    }
    if (m === "application/pdf") return "document";
    if (m.startsWith("text/")) return "note";
  }
  if (filename) {
    const ext = fileExtension(filename);
    if (ext && EXT_TO_CATEGORY[ext]) return EXT_TO_CATEGORY[ext]!;
  }
  return "other";
}

function fileExtension(filename: string): string | null {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

function basename(p: string): string {
  // Split on BOTH separators (a Windows-y caller may send backslashes).
  let last = p;
  const fwd = p.lastIndexOf("/");
  const back = p.lastIndexOf("\\");
  const cut = Math.max(fwd, back);
  if (cut >= 0) last = p.slice(cut + 1);
  return last;
}

/**
 * Sanitize a caller filename into ONE safe key segment (basename only; ASCII
 * allowlist [A-Za-z0-9._-]; every other byte → '_'; collapse '.'/'..'; cap
 * length). Returns null if nothing usable remains (caller falls back to uuid).
 * Mirrors the Rust `sanitize_filename_segment` so keys are canonical + log-safe.
 */
export function sanitizeFilenameSegment(filename: string): string | null {
  const base = basename(filename);
  let out = "";
  for (const ch of base) {
    if (out.length >= MAX_FILENAME_SEGMENT_LEN) break;
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch;
    else out += "_";
  }
  if (out.length === 0 || out === "." || out === "..") return null;
  return out;
}

/**
 * Build the canonical workspace key: `ai/<category>/<uuid>-<safe-filename>`
 * (or `ai/<category>/<uuid>` when the filename sanitizes to nothing). `uuid` is
 * injected so this is pure + testable; production passes `crypto.randomUUID()`
 * with hyphens stripped (32 hex chars), matching the Rust `uuid.simple()`.
 */
export function buildWorkspaceKey(
  category: Category,
  filename: string | undefined,
  uuidSimple: string,
): string {
  const safe = filename ? sanitizeFilenameSegment(filename) : null;
  const last = safe ? `${uuidSimple}-${safe}` : uuidSimple;
  return `${WORKSPACE_KEY_PREFIX}/${category}/${last}`;
}

/** A fresh 32-hex-char (hyphen-free) uuid, matching Rust `Uuid::new_v4().simple()`. */
export function freshUuidSimple(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Verify a key is segment-contained in the `ai/` scope (defense in depth; the
 * gateway also scopes the JWT to the AI-workspace bucket). Rejects traversal,
 * empty/doubled segments, and any non-`ai` first segment. Mirrors the spirit of
 * the Rust `assert_in_scope` SEGMENT (not substring) boundary.
 */
export function isInWorkspaceScope(key: string): boolean {
  if (!key || key.includes("\0")) return false;
  const segs = key.split("/");
  if (segs.length < 2) return false;
  if (segs[0] !== WORKSPACE_KEY_PREFIX) return false;
  for (const s of segs) {
    if (s.length === 0 || s === "." || s === "..") return false;
  }
  return true;
}
