/**
 * Collaboration manifest model + CRDT merge — Worker (TS) port of the Rust
 * `crates/fula-mcp/src/manifest.rs` `CollaborationGroup` / `CollaborationFile`
 * and `mergeWith`, themselves a faithful mirror of the Dart
 * `CollaborationGroup` / `CollaborationFile` and the web
 * `CollaborationManifest` / `CollaborationFile` (sharingService.ts).
 *
 * The manifest is a flat list of files; a folder tree is DERIVED from each
 * file's `pathScope` + `fileName` (see ./tree.ts). Field names are camelCase to
 * match the Dart `toJson` and the web portal exactly, so a manifest written here
 * is read by the Dart app and the web portal and vice-versa.
 *
 * JSON canonicalization: the read side (Dart `jsonDecode`, JS `JSON.parse`,
 * serde) is key-order-tolerant, so byte-identical JSON is NOT required for
 * interop. {@link serializeManifest} nonetheless emits the Dart `toJson` key
 * order (and omits the same optional fields) so a Worker re-serialization is a
 * faithful drop-in.
 */

/**
 * A file within a collaboration group. Mirrors the Dart `CollaborationFile`
 * (camelCase), including the conditional omission of `contentType` /
 * `pathScope` / `shareTokenJson` when absent. `encType` defaults to `"fula"` on
 * read (Dart `json['encType'] as String? ?? 'fula'`).
 */
export interface CollaborationFile {
  /** Unique identifier for this file entry (UUID). */
  id: string;
  /** Original filename. */
  fileName: string;
  /** MIME type (omitted from JSON when absent). */
  contentType?: string;
  /** Storage bucket for this file. */
  bucket: string;
  /** CID / storage key of the encrypted file in storage. */
  storageKey: string;
  /** Original path (for fula-encrypted files / folder markers; omitted when absent). */
  pathScope?: string;
  /** Base64 public key of whoever added this file. */
  addedByPublicKey: string;
  /** When this file was added (ISO-8601 string, verbatim). */
  addedAt: string;
  /** File size in bytes. */
  fileSize: number;
  /** `"fula"` (fula_client-encrypted owner file) or `"collab"` (collab-key-encrypted). */
  encType: "fula" | "collab";
  /** fula_client share-token JSON (only for `encType == "fula"`; omitted when absent). */
  shareTokenJson?: string;
}

/**
 * A named group of documents for bidirectional collaboration. Mirrors the Dart
 * `CollaborationGroup`. `isRevoked` and `files` are ALWAYS emitted;
 * `removedFileIds` is omitted when empty; `expiresAt` is omitted when absent.
 */
export interface CollaborationGroup {
  /** Unique identifier (the group UUID). */
  id: string;
  /** User-given name. */
  name: string;
  /** Base64-encoded public key of the group creator. */
  ownerPublicKey: string;
  /** Bucket where the manifest is stored (default `"fula-metadata"` on read). */
  manifestBucket: string;
  /** Path to the manifest JSON in the bucket. */
  manifestKey: string;
  /** When the group was created (ISO-8601 string). */
  createdAt: string;
  /** When the group expires (omitted when absent; absent = no expiry). */
  expiresAt?: string;
  /** Whether this group has been revoked (default `false` on read). */
  isRevoked: boolean;
  /** Files in this group. */
  files: CollaborationFile[];
  /** IDs of removed files (tombstones for merge correctness; omitted when empty). */
  removedFileIds: string[];
  /** Version counter for conflict resolution (default `1` on read). */
  version: number;
  /** Last time the manifest was updated (ISO-8601 string). */
  updatedAt: string;
}

const DEFAULT_MANIFEST_BUCKET = "fula-metadata";

/**
 * Tolerantly parse arbitrary JSON into a {@link CollaborationGroup}, applying
 * the same defaults the Dart `fromJson` / Rust serde `#[serde(default)]` use
 * (`manifestBucket ?? 'fula-metadata'`, `isRevoked ?? false`, `version ?? 1`,
 * `encType ?? 'fula'`, missing arrays → empty). Unknown extra keys are ignored.
 */
export function parseManifest(raw: unknown): CollaborationGroup {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("manifest is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const filesIn = Array.isArray(o.files) ? o.files : [];
  const files: CollaborationFile[] = filesIn.map((f) => {
    const r = (f ?? {}) as Record<string, unknown>;
    const encType = r.encType === "collab" ? "collab" : "fula";
    const file: CollaborationFile = {
      id: str(r.id),
      fileName: str(r.fileName),
      bucket: str(r.bucket),
      storageKey: str(r.storageKey),
      addedByPublicKey: str(r.addedByPublicKey),
      addedAt: str(r.addedAt),
      fileSize: typeof r.fileSize === "number" ? r.fileSize : 0,
      encType,
    };
    if (typeof r.contentType === "string") file.contentType = r.contentType;
    if (typeof r.pathScope === "string") file.pathScope = r.pathScope;
    if (typeof r.shareTokenJson === "string") file.shareTokenJson = r.shareTokenJson;
    return file;
  });
  const group: CollaborationGroup = {
    id: str(o.id),
    name: str(o.name),
    ownerPublicKey: str(o.ownerPublicKey),
    manifestBucket: typeof o.manifestBucket === "string" && o.manifestBucket ? o.manifestBucket : DEFAULT_MANIFEST_BUCKET,
    manifestKey: str(o.manifestKey),
    createdAt: str(o.createdAt),
    isRevoked: o.isRevoked === true,
    files,
    removedFileIds: Array.isArray(o.removedFileIds)
      ? o.removedFileIds.filter((x): x is string => typeof x === "string")
      : [],
    version: typeof o.version === "number" ? o.version : 1,
    updatedAt: str(o.updatedAt),
  };
  if (typeof o.expiresAt === "string") group.expiresAt = o.expiresAt;
  return group;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Serialize a manifest to the Dart `toJson` byte shape: every object literal is
 * built field-by-field in the Dart key order (NOT spread), optional fields are
 * omitted exactly as Dart does (`contentType`/`pathScope`/`shareTokenJson` per
 * file; `expiresAt`; `removedFileIds` when empty). Compact JSON (no spaces).
 */
export function serializeManifest(group: CollaborationGroup): string {
  const files = group.files.map((f) => {
    const out: Record<string, unknown> = {
      id: f.id,
      fileName: f.fileName,
    };
    if (f.contentType !== undefined) out.contentType = f.contentType;
    out.bucket = f.bucket;
    out.storageKey = f.storageKey;
    if (f.pathScope !== undefined) out.pathScope = f.pathScope;
    out.addedByPublicKey = f.addedByPublicKey;
    out.addedAt = f.addedAt;
    out.fileSize = f.fileSize;
    out.encType = f.encType;
    if (f.shareTokenJson !== undefined) out.shareTokenJson = f.shareTokenJson;
    return out;
  });
  const ordered: Record<string, unknown> = {
    id: group.id,
    name: group.name,
    ownerPublicKey: group.ownerPublicKey,
    manifestBucket: group.manifestBucket,
    manifestKey: group.manifestKey,
    createdAt: group.createdAt,
  };
  if (group.expiresAt !== undefined) ordered.expiresAt = group.expiresAt;
  ordered.isRevoked = group.isRevoked;
  ordered.files = files;
  if (group.removedFileIds.length > 0) ordered.removedFileIds = group.removedFileIds;
  ordered.version = group.version;
  ordered.updatedAt = group.updatedAt;
  return JSON.stringify(ordered);
}

/** A deep-ish clone of a manifest (used so a mutate-then-merge never aliases). */
export function cloneManifest(g: CollaborationGroup): CollaborationGroup {
  return {
    ...g,
    files: g.files.map((f) => ({ ...f })),
    removedFileIds: [...g.removedFileIds],
  };
}

/**
 * CRDT merge of two manifest versions — a faithful port of the Rust
 * `CollaborationGroup::merge_with` (itself a mirror of Dart `mergeWith`), with
 * the wall-clock injected as `now` (keeps the merge a pure, testable function).
 *
 * Semantics (all security-relevant):
 *  - Tombstones: union `removedFileIds` from both sides (first-seen order, self
 *    first).
 *  - Files: union by `id`; on a conflicting `id`, `self` (the receiver) wins
 *    (insert self's files first, then other via put-if-absent). Tombstoned files
 *    are dropped, then the result is stable-sorted by `addedAt`.
 *  - Revocation is monotonic: revoked on EITHER side ⇒ revoked.
 *  - Expiry can only SHORTEN: the earlier of the two wins (absent = no expiry =
 *    least restrictive, so a present expiry always wins over absent).
 *  - Version: `max(self, other) + 1`.
 *  - The remaining scalars (`id`/`name`/`ownerPublicKey`/`manifestBucket`/
 *    `manifestKey`/`createdAt`) come from the higher-version side (`self` on tie).
 */
export function mergeWith(
  self: CollaborationGroup,
  other: CollaborationGroup,
  now: string,
): CollaborationGroup {
  // Union tombstones, preserving first-seen order (self's ids first).
  const mergedTombstones: string[] = [];
  const seen = new Set<string>();
  for (const id of [...self.removedFileIds, ...other.removedFileIds]) {
    if (!seen.has(id)) {
      seen.add(id);
      mergedTombstones.push(id);
    }
  }
  const tombstoneSet = new Set(mergedTombstones);

  // Union files by id: self wins on conflict (self first, then other put-if-absent).
  const order: string[] = [];
  const byId = new Map<string, CollaborationFile>();
  for (const f of self.files) {
    if (!byId.has(f.id)) order.push(f.id);
    byId.set(f.id, f); // self: last-wins on value
  }
  for (const f of other.files) {
    if (!byId.has(f.id)) {
      order.push(f.id);
      byId.set(f.id, f); // other: put-if-absent
    }
  }
  const mergedFiles = order
    .filter((id) => !tombstoneSet.has(id))
    .map((id) => byId.get(id)!)
    .slice(); // copy
  // Stable sort by addedAt (naive wall-clock instant).
  stableSort(mergedFiles, (a, b) => cmpIso8601(a.addedAt, b.addedAt));

  const base = self.version >= other.version ? self : other;
  const merged: CollaborationGroup = {
    id: base.id,
    name: base.name,
    ownerPublicKey: base.ownerPublicKey,
    manifestBucket: base.manifestBucket,
    manifestKey: base.manifestKey,
    createdAt: base.createdAt,
    isRevoked: self.isRevoked || other.isRevoked, // monotonic
    files: mergedFiles,
    removedFileIds: mergedTombstones,
    version: Math.max(self.version, other.version) + 1,
    updatedAt: now,
  };
  const exp = earlierExpiry(self.expiresAt, other.expiresAt); // shrink-only
  if (exp !== undefined) merged.expiresAt = exp;
  return merged;
}

// ── ISO-8601 naive comparison (dependency-free) ──────────────────────────────

/**
 * Parse an ISO-8601-ish `YYYY-MM-DDTHH:MM:SS[.frac][Z]` into a comparable tuple,
 * treating it as a NAIVE wall-clock value (trailing `Z` stripped, fractional
 * seconds normalized to microseconds). Mirrors how the Dart app compares
 * timestamps. Returns `null` for an unrecognized shape.
 */
function parseIso8601Naive(s: string): [number, number, number, number, number, number, number] | null {
  const noZ = s.endsWith("Z") ? s.slice(0, -1) : s;
  const tIdx = noZ.indexOf("T");
  if (tIdx < 0) return null;
  const date = noZ.slice(0, tIdx);
  const time = noZ.slice(tIdx + 1);

  const d = date.split("-");
  if (d.length !== 3) return null;
  const year = intOrNull(d[0]);
  const month = intOrNull(d[1]);
  const day = intOrNull(d[2]);
  if (year === null || month === null || day === null) return null;

  const t = time.split(":");
  if (t.length !== 3) return null;
  const hour = intOrNull(t[0]);
  const minute = intOrNull(t[1]);
  if (hour === null || minute === null) return null;
  const secPart = t[2]!;
  const dot = secPart.indexOf(".");
  const secStr = dot >= 0 ? secPart.slice(0, dot) : secPart;
  const fracStr = dot >= 0 ? secPart.slice(dot + 1) : "";
  const second = intOrNull(secStr);
  if (second === null) return null;

  let micros = 0;
  if (fracStr.length > 0) {
    let buf = "";
    for (const c of fracStr.slice(0, 6)) {
      if (c < "0" || c > "9") return null;
      buf += c;
    }
    while (buf.length < 6) buf += "0";
    micros = parseInt(buf, 10);
  }
  return [year, month, day, hour, minute, second, micros];
}

function intOrNull(s: string | undefined): number | null {
  if (s === undefined || s.length === 0 || !/^[0-9]+$/.test(s)) return null;
  return parseInt(s, 10);
}

/** Compare two ISO-8601 naive timestamps; falls back to a string compare. */
function cmpIso8601(a: string, b: string): number {
  const pa = parseIso8601Naive(a);
  const pb = parseIso8601Naive(b);
  if (pa && pb) {
    for (let i = 0; i < pa.length; i++) {
      if (pa[i]! < pb[i]!) return -1;
      if (pa[i]! > pb[i]!) return 1;
    }
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The earlier (more restrictive) of two expiries — the shrink-only rule. Absent
 * means "no expiry" (least restrictive), so a present expiry always wins over
 * absent. FAIL-CLOSED on a malformed string (a garbage expiry never wins and
 * extends the access window). Mirrors Rust `earlier_expiry` + `min_expiry`.
 */
function earlierExpiry(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const pa = parseIso8601Naive(a);
  const pb = parseIso8601Naive(b);
  if (pa && pb) {
    return cmpIso8601(a, b) < 0 ? a : b; // tie → b (Dart `isBefore ? a : b`)
  }
  if (pa && !pb) return a; // keep the real instant
  if (!pa && pb) return b;
  return a <= b ? a : b; // both malformed: deterministic
}

/** A stable in-place sort (Array.prototype.sort is spec-stable in V8, but we
 *  keep this explicit so the merge ordering is unambiguous + portable). */
function stableSort<T>(arr: T[], cmp: (a: T, b: T) => number): void {
  const indexed = arr.map((v, i) => [v, i] as const);
  indexed.sort((x, y) => {
    const c = cmp(x[0], y[0]);
    return c !== 0 ? c : x[1] - y[1];
  });
  for (let i = 0; i < arr.length; i++) arr[i] = indexed[i]![0];
}
