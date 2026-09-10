/**
 * Revision ("Recreate") prompt.
 *
 * The generation pipeline's job is to invent: its brief pass asks for "a
 * design concept unique to this brand" and its polish pass asks for a site
 * that is "MORE distinctive, not safer". That is exactly wrong for an
 * edit. Revision runs ONE pass whose entire purpose is restraint — change
 * what was asked for, leave everything else alone.
 */

import type { WebsiteFile } from '../services/claudeService.js';

/**
 * Output schema for the revision pass. `deleted_files` exists because a
 * patch merge can only add and replace: without it the model has no way
 * to act on "remove the contact page" and would silently leave it there.
 */
export const REVISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    deleted_files: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['files'],
  additionalProperties: false,
};

/**
 * Render the current source for the model.
 *
 * XML tags rather than a JSON blob: they survive the model's own quoting
 * without escaping, so the HTML inside arrives byte-for-byte as it is on
 * disk — which is the whole point of an edit pass.
 */
export function renderExistingFiles(files: WebsiteFile[]): string {
  const parts = ['<existing_files>'];
  for (const file of files) {
    parts.push(`<file path="${file.path}">`);
    parts.push(file.content);
    parts.push('</file>');
  }
  parts.push('</existing_files>');
  return parts.join('\n');
}

export const REVISION_INSTRUCTION = `You are EDITING the existing website above. You are NOT designing a new one.

This is a revision of a site the user already has and already approved. Your job is restraint, not creativity. The design, the copy, the layout, the color system, the type system, the motion and the structure are all CORRECT AS THEY ARE unless the change request below says otherwise.

The system instructions above describe how to BUILD a new site from nothing. This is not that task. Where they pull toward inventing, restructuring or making the design more distinctive, THESE rules win.

RULES — follow every one:
1. Apply ONLY what the change request (and the listed settings changes, if any) ask for. Nothing else.
2. Everything you were not asked to change must come back BYTE-IDENTICAL. Do not reword copy, rename classes or ids, reorder sections, reformat, re-indent, "tidy", modernize, or improve anything outside the requested change. Resist the urge to polish — an unrequested improvement is a defect here.
2b. This applies WITHIN a file you do edit, not just between files: make the smallest edit that satisfies the request and leave every other line of that file exactly as you found it.
3. Return ONLY the files you actually modified, plus any genuinely new file. OMIT every file you did not change — unchanged files are kept automatically. Do not return a file just to prove you read it.
4. When you do change a file, return its COMPLETE new content, not a fragment or a diff.
5. To remove a file, list its path in "deleted_files". Never delete index.html.
6. If the change request asks for nothing that affects the site, return {"files": []}.
7. The site's original requirements are included below for CONTEXT ONLY. The existing site already satisfies them — do NOT restructure the site to match them more closely, and do not re-apply them.
8. Keep the site's existing rules intact: relative internal paths, no external scripts/styles/fonts, provided asset URLs used exactly as given.

Return ONLY the raw JSON object { "files": [ ... ], "deleted_files": [ ... ] } — no markdown fences, no commentary.`;

export interface RevisionUserTextInput {
  /** What the user typed. Empty when only settings changed. */
  revisionRequest: string;
  /** Plain-sentence description of generator-screen settings that moved. */
  settingsDelta: string[];
  /** The full new enriched prompt — reference context, not a work order. */
  requirements: string;
}

/** The change request + settings delta + reference requirements. */
export function buildRevisionUserText(input: RevisionUserTextInput): string {
  const request = input.revisionRequest.trim();
  const parts: string[] = [];

  parts.push('<change_request>');
  parts.push(
    request.length > 0
      ? request
      : '(The user typed no change request. Apply only the settings changes listed below.)'
  );
  parts.push('</change_request>');

  if (input.settingsDelta.length > 0) {
    parts.push('');
    parts.push('<settings_changed>');
    for (const line of input.settingsDelta) parts.push(`- ${line}`);
    parts.push('</settings_changed>');
  }

  parts.push('');
  parts.push(
    '<original_requirements note="CONTEXT ONLY — the existing site already satisfies these. Do not restructure the site to match them.">'
  );
  parts.push(input.requirements);
  parts.push('</original_requirements>');

  return parts.join('\n');
}

/**
 * Truncation recovery for a revision.
 *
 * Deliberately NOT the generation pipeline's retry, which says "regenerate
 * the COMPLETE site at roughly 60% of that size" — on an edit that would
 * throw away most of a site the user is happy with. The only safe way to
 * shrink a revision's output is to return fewer files.
 */
export const REVISION_TRUNCATION_RETRY_INSTRUCTION = `Your previous response was cut off before it finished. Return the SAME edit again, but smaller: include ONLY the files that genuinely must change for the requested edit, and omit every other file. Do not shrink, simplify, or redesign the site itself — the files you do return must still be complete and must still preserve everything you were not asked to change. Return ONLY the raw JSON object { "files": [ ... ], "deleted_files": [ ... ] }.`;
