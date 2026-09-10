/**
 * Revision planning — pure functions, no I/O.
 *
 * A "revision" is a generation that EDITS an existing site instead of
 * designing a new one. Two questions have to be answered consistently in
 * two different places, so both live here:
 *
 *   1. Is there actually anything to change?  The route needs this BEFORE
 *      it charges (a user who changed nothing must not pay), and the
 *      worker needs it to decide whether to call the model at all.
 *      Deriving it twice is how the two would drift apart.
 *
 *   2. WHAT changed?  The user's free-text request is only half of it —
 *      the generator screen also carries name, category, styles, palette,
 *      languages and the contact form. If the user switches the palette
 *      and types nothing, "apply only what the user asked for" has to
 *      mean the palette.
 */

import { stripLegacyConstraintsBlock } from '../prompts/promptCompat.js';

/** One asset as it travels in the request body and the `assets` column. */
interface AssetLike {
  fileName?: string;
  url?: string;
}

/**
 * CRLF and trailing whitespace are transport noise, not intent.
 *
 * The legacy client constraints block goes too: a site built by an older
 * FxFiles carries it in its stored prompt while today's client no longer
 * sends one, so comparing raw strings would call every such site
 * "changed" and deny it the unchanged answer it qualifies for.
 */
function normalizePrompt(prompt: string): string {
  return stripLegacyConstraintsBlock(prompt).replace(/\r\n/g, '\n').trim();
}

/**
 * Identity of an asset SET, order-insensitive.
 *
 * `fileName|url` is enough: the URL carries the content's CID, so equal
 * URLs mean equal bytes. Parsed text content is deliberately excluded —
 * it can be re-extracted slightly differently between runs without the
 * user having changed anything.
 */
function assetSetKey(assets: AssetLike[] | null | undefined): string {
  return (assets || [])
    .map((a) => `${a?.fileName ?? ''}|${a?.url ?? ''}`)
    .sort()
    .join('\n');
}

export interface NoOpRevisionInput {
  /** Enriched prompt the base site was generated from. */
  basePrompt: string;
  baseAssets: AssetLike[] | null | undefined;
  /** Enriched prompt for this job. */
  newPrompt: string;
  newAssets: AssetLike[] | null | undefined;
  /** What the user typed into the "what should change?" field. */
  revisionRequest: string | null | undefined;
}

/**
 * True when this revision asks for nothing at all — no change request, the
 * same settings, the same assets.
 *
 * The prompt test is exact string equality, NOT a parse of the header
 * lines. Any settings change anywhere in the enriched prompt — including
 * blocks this module knows nothing about — makes the strings differ, so a
 * new hidden block can never silently fall through as "unchanged".
 *
 * Publish-time flags (tracking) are deliberately NOT considered: they
 * change how the same source is published, not the source itself.
 */
export function isNoOpRevision(input: NoOpRevisionInput): boolean {
  if ((input.revisionRequest ?? '').trim().length > 0) return false;
  if (normalizePrompt(input.basePrompt) !== normalizePrompt(input.newPrompt)) {
    return false;
  }
  return assetSetKey(input.baseAssets) === assetSetKey(input.newAssets);
}

// ---------------------------------------------------------------- delta

/**
 * Split an enriched prompt into its `=== NAME (auto-added…) ===` blocks
 * plus the trailing `User request:` body.
 *
 * Section names are normalized to the part before ` (`, so the contact
 * form's two spellings — `=== CONTACT FORM (auto-added) ===` and
 * `=== CONTACT FORM (auto-added — overrides …) ===` — are one section
 * rather than an add plus a remove.
 */
function splitPromptSections(prompt: string): {
  sections: Map<string, string>;
  userRequest: string;
} {
  const sections = new Map<string, string>();
  const lines = normalizePrompt(prompt).split('\n');

  let current: string | null = null;
  let buffer: string[] = [];
  const userRequestLines: string[] = [];
  let inUserRequest = false;

  const flush = () => {
    if (current !== null) sections.set(current, buffer.join('\n').trim());
    current = null;
    buffer = [];
  };

  for (const line of lines) {
    const open = /^===\s+(?!END\b)(.+?)\s+===$/.exec(line);
    const close = /^===\s+END\b.*===$/.exec(line);
    if (open) {
      flush();
      inUserRequest = false;
      current = open[1].split(' (')[0].trim();
      continue;
    }
    if (close) {
      flush();
      continue;
    }
    if (current !== null) {
      buffer.push(line);
      continue;
    }
    if (/^User request:\s*$/.test(line)) {
      inUserRequest = true;
      continue;
    }
    if (inUserRequest) userRequestLines.push(line);
  }
  flush();

  return { sections, userRequest: userRequestLines.join('\n').trim() };
}

/** Value of a `Header: value` line inside the user-request body. */
function headerValue(userRequest: string, header: string): string | null {
  const re = new RegExp(`^${header}:\\s*(.*)$`, 'm');
  const m = re.exec(userRequest);
  return m ? m[1].trim() : null;
}

/** The user-request body with its header lines removed — the free text. */
function requestBody(userRequest: string): string {
  return userRequest
    .replace(/^(Website Name|Category|Styles|Palette|Languages|ContactForm):.*$\n?/gm, '')
    .trim();
}

/** Human-readable name for a section, for the delta lines. */
const SECTION_LABELS: Record<string, string> = {
  'TYPE-SPECIFIC CONSTRAINTS': 'the site category',
  'STYLE PREFERENCES': 'the visual style',
  'PALETTE PREFERENCE': 'the color palette',
  'SITE LANGUAGES': 'the site languages',
  'CONTACT FORM': 'the contact form',
  'ATTACHED ASSET NOTES': 'the per-asset notes',
};

/**
 * Describe, in plain sentences, what the user changed in the generator
 * screen between the base site and this revision.
 *
 * Best-effort by design: the authoritative "did anything change?" test is
 * [isNoOpRevision]'s string equality. This only produces guidance for the
 * model, so an imperfect description degrades the hint, never correctness
 * — the model is given the full new requirements either way.
 */
export function describeSettingsDelta(
  basePrompt: string,
  newPrompt: string
): string[] {
  const base = splitPromptSections(basePrompt);
  const next = splitPromptSections(newPrompt);
  const deltas: string[] = [];

  for (const header of ['Website Name', 'Category', 'Styles', 'Palette'] as const) {
    const before = headerValue(base.userRequest, header);
    const after = headerValue(next.userRequest, header);
    if (before !== after && (before !== null || after !== null)) {
      deltas.push(
        `${header} changed from "${before ?? '(none)'}" to "${after ?? '(none)'}".`
      );
    }
  }

  const names = new Set([...base.sections.keys(), ...next.sections.keys()]);
  for (const name of names) {
    const before = base.sections.get(name);
    const after = next.sections.get(name);
    if (before === after) continue;
    const label = SECTION_LABELS[name] ?? `the "${name}" requirements`;
    if (before === undefined) deltas.push(`The user ADDED ${label}.`);
    else if (after === undefined) deltas.push(`The user REMOVED ${label}.`);
    else deltas.push(`The user CHANGED ${label}.`);
  }

  if (requestBody(base.userRequest) !== requestBody(next.userRequest)) {
    deltas.push('The written description of the site was edited.');
  }

  return deltas;
}
