/**
 * Multi-pass generation prompts.
 *
 * One shared system prompt serves every pass (brief → build → polish) —
 * pass-role differentiation happens in user turns. That keeps the whole
 * system prefix byte-stable across passes AND across concurrent jobs, so
 * Anthropic prompt caching serves it from cache on passes B/C (the
 * cache_control breakpoint sits on the last system block).
 */

import Anthropic from '@anthropic-ai/sdk';
import { composeWebsiteSystemPrompt } from './designSkill.js';
import { DESIGN_SYSTEM_PROMPT, OUTPUT_POLICY_PROMPT } from './designSystem.js';

/**
 * Shared system blocks for every generation pass: service contract +
 * output policy + first-party design system + (optionally) the vendored
 * micro-interaction skill, with a cache breakpoint on the end.
 */
export function composeSharedSystemBlocks(
  baseSystemPrompt: string,
  designSkillEnabled: boolean,
): Anthropic.TextBlockParam[] {
  const composed = composeWebsiteSystemPrompt(
    `${baseSystemPrompt}\n\n${OUTPUT_POLICY_PROMPT}\n\n${DESIGN_SYSTEM_PROMPT}`,
    designSkillEnabled,
  );
  return [
    {
      type: 'text',
      text: composed,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/** Pass A — art direction. Plain text out, never JSON/code. */
export const BRIEF_PASS_INSTRUCTION = `Before writing any code, produce an ART DIRECTION BRIEF as plain text (never JSON, never code). Be decisive — commit to one direction, no options, no hedging:
1. CONCEPT — one sentence naming a design concept unique to this brand and request (not "clean and modern").
2. LAYOUT — which archetype from the design system and why, then a section-by-section storyboard grounded in the ACTUAL content and assets provided: name each section, what it contains, and name each provided asset and exactly where/how it is used (framing, treatment, size).
3. TYPE SYSTEM — display and text stacks (self-contained only), weights, the modular scale ratio, and the hero display size.
4. COLOR SYSTEM — every color as a hex value with its role (surface, ink, accent, tints), including a note that body text passes 4.5:1 on its surface.
5. MOTION LANGUAGE — the page-load choreography, the scroll-reveal behavior, and at least 3 named micro-interactions tied to specific elements.
6. SIGNATURE ELEMENT — the one distinctive structural or decorative element that makes this site memorable.`;

/** Pass B — build the full site from the brief. Raw files JSON out. */
export const BUILD_PASS_INSTRUCTION = `Now build the COMPLETE site, implementing the brief above exactly — every section of the storyboard, the full type/color system as CSS custom properties, the shared IntersectionObserver reveal utility with staggering, the named micro-interactions, and prefers-reduced-motion fallbacks. Verify layout logic at 360px, 768px, and 1200px widths. Return ONLY the raw JSON object { "files": [ ... ] } — no markdown fences, no commentary before or after.`;

/** Pass C — self-critique and polish. May return only changed files. */
export const POLISH_PASS_INSTRUCTION = `Review the site you just produced as a demanding art director, then fix what you find. Hunt specifically for: generic or repeated section skeletons; weak hero impact; type scale inconsistencies; contrast failures (body text below 4.5:1, large text below 3:1); interactive elements missing hover/focus/press states; mobile overflow or cramped spacing at 360px; missing prefers-reduced-motion handling; provided assets that were dropped or given lazy framing; dead anchors; invented facts. FUNCTIONAL checks (walk the code, do not assume): every menu/nav overlay is hidden by its DEFAULT CSS state and only a toggle class opens it — trace the CSS to confirm the closed state needs no JS; sticky headers stay compact when closed; reveal-hidden styles are scoped behind the html.js class so the page is fully visible without JavaScript. Strengthen the design where it is timid — this pass should make the site MORE distinctive, not safer. Then return ONLY the raw JSON object { "files": [ ... ] } with the improved files. You MAY return only the files you changed; unchanged files will be kept as-is.`;

/** Truncation recovery — regenerate complete at a reduced size. */
export const TRUNCATION_RETRY_INSTRUCTION = `Your previous response was cut off before completing. Regenerate the COMPLETE site now at roughly 60% of that size: consolidate CSS with custom properties and shared utility classes, drop the least essential section entirely, and shorten copy — but keep the design system, the motion layer, and the visual quality intact. Return ONLY the complete raw JSON object { "files": [ ... ] }.`;
