import { describe, expect, it } from 'vitest';

import {
  LEGACY_CONSTRAINTS_END,
  LEGACY_CONSTRAINTS_START,
  hasLegacyConstraintsBlock,
  stripLegacyConstraintsBlock,
} from '../src/prompts/promptCompat.js';

// Verbatim shape of the client's legacy prepend (websiteSystemInstructions
// in FxFiles website_prompt_builder.dart): block, blank line, then the
// enriched blocks / user request.
const LEGACY_BLOCK = `${LEGACY_CONSTRAINTS_START}
Output budget: Your TOTAL JSON response must be UNDER 40KB (~10,000 tokens). Plan accordingly — do NOT start generating a large site that will get cut off mid-output.

File strategy:
- Generate 1-3 files MAX (index.html, style.css, optionally script.js).
- Write clean but concise code. Avoid verbose comments or redundant CSS resets.

Design:
- Mobile-responsive layout with clean typography.
${LEGACY_CONSTRAINTS_END}
`;

const TAIL = `=== TYPE-SPECIFIC CONSTRAINTS (auto-added) ===
Shop rules here.
=== END TYPE-SPECIFIC CONSTRAINTS ===

User request:
Website Name: Test Shop
Sell fresh bread.`;

describe('promptCompat', () => {
  it('detects the legacy block', () => {
    expect(hasLegacyConstraintsBlock(`${LEGACY_BLOCK}\n${TAIL}`)).toBe(true);
    expect(hasLegacyConstraintsBlock(TAIL)).toBe(false);
  });

  it('strips the legacy block and preserves everything after it', () => {
    const stripped = stripLegacyConstraintsBlock(`${LEGACY_BLOCK}\n${TAIL}`);
    expect(stripped).toBe(TAIL);
    expect(stripped).not.toContain('40KB');
    expect(stripped).not.toContain('1-3 files');
    expect(stripped).toContain('Sell fresh bread.');
  });

  it('is idempotent and a no-op on new-style prompts', () => {
    const once = stripLegacyConstraintsBlock(`${LEGACY_BLOCK}\n${TAIL}`);
    expect(stripLegacyConstraintsBlock(once)).toBe(once);
    expect(stripLegacyConstraintsBlock(TAIL)).toBe(TAIL);
  });

  it('leaves a start marker without an end marker alone', () => {
    const broken = `${LEGACY_CONSTRAINTS_START}\nsome text\nUser request: hi`;
    expect(stripLegacyConstraintsBlock(broken)).toBe(broken);
  });
});
