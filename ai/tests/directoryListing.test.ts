import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/index.js', () => ({
  config: {
    claudeApiKey: 'test-only-key',
    claudeModel: 'claude-opus-5',
    claudeSocialModel: '',
  },
}));

// The DB module opens a pg Pool on import; the pure helpers under test
// don't touch it, so stub it out rather than requiring a database.
vi.mock('../src/database/directory_postgres.js', () => ({
  getActiveCategories: vi.fn(),
  needsListingSummary: vi.fn(),
  saveListingSummary: vi.fn(),
}));
vi.mock('../src/database/postgres.js', () => ({
  getGeneration: vi.fn(),
}));

import {
  clipDescription,
  coerceCategory,
  containsLikelyContactDetails,
  extractSiteText,
  FALLBACK_CATEGORY,
  LISTING_DESCRIPTION_MAX_CHARS,
} from '../src/services/directoryListing.js';

describe('containsLikelyContactDetails', () => {
  // The description is content WE generate and publish into a searchable
  // index. Telling the model not to include contact details is not a
  // control; this is the backstop on the text that actually ships.
  it('catches plain emails', () => {
    expect(
      containsLikelyContactDetails('Bakery run by jane@example.com')
    ).toBe(true);
  });

  it('catches obfuscated emails', () => {
    expect(
      containsLikelyContactDetails('Reach jane [at] example [dot] com')
    ).toBe(true);
  });

  it('catches phone numbers, separators and all', () => {
    expect(containsLikelyContactDetails('Call +1 (555) 123-4567')).toBe(true);
    expect(containsLikelyContactDetails('Tel: 020 7946 0018')).toBe(true);
  });

  it('catches URLs and bare domains', () => {
    expect(containsLikelyContactDetails('See https://elsewhere.test')).toBe(
      true
    );
    expect(containsLikelyContactDetails('Visit example.com for more')).toBe(
      true
    );
  });

  it('leaves an ordinary blurb alone', () => {
    expect(
      containsLikelyContactDetails(
        'A neighbourhood bakery selling sourdough and pastries.'
      )
    ).toBe(false);
    expect(
      containsLikelyContactDetails('Portfolio of a landscape photographer.')
    ).toBe(false);
  });

  it('tolerates a year or a small number', () => {
    expect(
      containsLikelyContactDetails('A community choir founded in 1998.')
    ).toBe(false);
    expect(containsLikelyContactDetails('Serving 20 kinds of tea.')).toBe(
      false
    );
  });
});

describe('extractSiteText', () => {
  it('drops script and style bodies', () => {
    const html = `
      <html><head>
        <title>Corner Bakery</title>
        <style>.a{color:red}</style>
        <script>var secret = "do not summarise me";</script>
      </head><body><p>Fresh sourdough daily.</p></body></html>`;
    const text = extractSiteText(html);
    expect(text).toContain('Corner Bakery');
    expect(text).toContain('Fresh sourdough daily.');
    expect(text).not.toContain('do not summarise me');
    expect(text).not.toContain('color:red');
  });

  it('lifts the title and meta description to the front', () => {
    const html = `<html><head>
        <title>Blue Door Clinic</title>
        <meta name="description" content="Physiotherapy in Leeds">
      </head><body><p>Body copy here.</p></body></html>`;
    const text = extractSiteText(html);
    expect(text.indexOf('Blue Door Clinic')).toBeLessThan(
      text.indexOf('Body copy here.')
    );
    expect(text).toContain('Physiotherapy in Leeds');
  });

  it('strips tags, decodes entities and collapses whitespace', () => {
    const html = '<p>A   &amp;   B</p>\n\n<div>C&nbsp;D</div>';
    expect(extractSiteText(html)).toBe('A & B C D');
  });

  it('drops HTML comments', () => {
    expect(extractSiteText('<p>Hi</p><!-- internal note -->')).toBe('Hi');
  });

  it('bounds the text it will send to the model', () => {
    const html = `<p>${'word '.repeat(5000)}</p>`;
    expect(extractSiteText(html).length).toBeLessThanOrEqual(6000);
  });

  it('returns empty for a page with no visible text', () => {
    expect(extractSiteText('<html><body></body></html>')).toBe('');
  });
});

describe('clipDescription', () => {
  it('leaves a short description alone', () => {
    expect(clipDescription('A bakery in Leeds.')).toBe('A bakery in Leeds.');
  });

  it('collapses whitespace', () => {
    expect(clipDescription('  A   bakery\nin Leeds. ')).toBe(
      'A bakery in Leeds.'
    );
  });

  it('never exceeds the column contract', () => {
    const long = 'x'.repeat(400);
    expect(clipDescription(long).length).toBeLessThanOrEqual(
      LISTING_DESCRIPTION_MAX_CHARS
    );
  });

  it('prefers a word boundary when clipping', () => {
    const long = `${'alpha beta '.repeat(30)}`;
    const out = clipDescription(long);
    expect(out.endsWith('…')).toBe(true);
    // Should not have cut mid-word before the ellipsis.
    expect(out.replace('…', '').trimEnd()).toMatch(/(alpha|beta)$/);
  });
});

describe('coerceCategory', () => {
  const allowed = ['business', 'food', FALLBACK_CATEGORY];

  it('accepts a slug we offer', () => {
    expect(coerceCategory('food', allowed)).toBe('food');
  });

  it('is case and whitespace insensitive', () => {
    expect(coerceCategory('  FOOD ', allowed)).toBe('food');
  });

  it('falls back when the model invents a slug', () => {
    // A hallucinated category must not become an unfilterable value in
    // the directory.
    expect(coerceCategory('artisanal-sourdough', allowed)).toBe(
      FALLBACK_CATEGORY
    );
    expect(coerceCategory('', allowed)).toBe(FALLBACK_CATEGORY);
  });

  it('falls back to the first allowed slug when there is no "other"', () => {
    expect(coerceCategory('nope', ['business', 'food'])).toBe('business');
  });
});
