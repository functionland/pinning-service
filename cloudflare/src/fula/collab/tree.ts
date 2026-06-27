/**
 * Pure path / tree helpers over the collaboration manifest — Worker (TS) port of
 * the Rust `crates/fula-mcp/src/tree.rs`.
 *
 * The manifest is a flat list of files; a folder tree is DERIVED from each file's
 * `pathScope` + `fileName`, with directories represented by marker entries whose
 * `contentType` is {@link DIRECTORY_CONTENT_TYPE}. All helpers are pure (no I/O).
 *
 * `pathScope` is interpreted leniently because two producers write it differently:
 * the AI (this Worker / the Rust MCP) writes the containing FOLDER (e.g. `/notes`),
 * while the FxFiles app sometimes writes the file's FULL path (e.g.
 * `/legal/contract.pdf`). {@link logicalPathOf} reconciles both. Since every file
 * in the manifest is in-group (hence authorized), a mismatched interpretation is
 * at worst a display nuance, never an access decision.
 */

import type { CollaborationFile, CollaborationGroup } from "./manifest.js";

/** The `contentType` marking a manifest entry as a folder (not a file). */
export const DIRECTORY_CONTENT_TYPE = "application/x-directory";

/** Is this manifest entry a folder marker? */
export function isDirectory(file: CollaborationFile): boolean {
  return file.contentType === DIRECTORY_CONTENT_TYPE;
}

/**
 * Normalize a user-supplied folder path to canonical `/a/b` form (leading slash,
 * no trailing slash, collapsed inner slashes). Returns `null` for the group root
 * (empty / `/`), a `/a/b` string for a real folder, or throws for a path with a
 * `.` / `..` segment or a NUL.
 */
export function normalizeFolder(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed === "/") return null;
  if (trimmed.includes("\0")) throw new Error("path must not contain a NUL byte");
  const segs: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (seg.length === 0) continue; // collapse // and leading/trailing /
    if (seg === "." || seg === "..") throw new Error("path must not contain `.` or `..` segments");
    segs.push(seg);
  }
  if (segs.length === 0) return null;
  return "/" + segs.join("/");
}

/**
 * The user-facing logical path of a manifest entry (file or folder marker).
 * `pathScope` is treated as a full path when its last segment equals `fileName`,
 * otherwise as the containing folder.
 */
export function logicalPathOf(file: CollaborationFile): string {
  const name = trimSlashes(file.fileName);
  let dir: string | null = null;
  if (file.pathScope !== undefined) {
    try {
      dir = normalizeFolder(file.pathScope);
    } catch {
      dir = null;
    }
  }
  if (dir === null) return `/${name}`;
  const leaf = dir.split("/").pop() ?? "";
  if (leaf === name) return dir; // pathScope already IS the full path (Dart style)
  return `${dir}/${name}`; // pathScope is the containing folder
}

/**
 * Is `logicalPath` strictly UNDER `folder` (segment-boundary)? A root/invalid
 * `folder` imposes no restriction (everything matches). The folder marker for
 * `folder` itself is NOT considered under it (only its contents are).
 */
export function pathUnderFolder(logicalPath: string, folder: string): boolean {
  let dir: string | null;
  try {
    dir = normalizeFolder(folder);
  } catch {
    return true;
  }
  if (dir === null) return true;
  return logicalPath.startsWith(`${dir}/`);
}

/** Is `id` tombstoned (present in `removedFileIds`)? */
export function isTombstoned(group: CollaborationGroup, id: string): boolean {
  return group.removedFileIds.includes(id);
}

/** The live (non-tombstoned) entries of a manifest, in manifest order. */
export function liveFiles(group: CollaborationGroup): CollaborationFile[] {
  return group.files.filter((f) => !isTombstoned(group, f.id));
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}
