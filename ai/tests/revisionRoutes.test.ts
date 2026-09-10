import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * The revision ("Recreate") contract at the route boundary.
 *
 * The bug this feature fixes was silent: a Recreate looked like a normal
 * generation, was charged like one, and came back a completely different
 * site. So the guarantees worth pinning here are the ones a user would
 * otherwise only discover after paying —
 *
 *   - an edit that asks for nothing costs nothing and returns the site
 *     the user already has, INCLUDING for sites generated before the
 *     source was ever stored,
 *   - an edit that asks for something on a site with no stored source is
 *     refused up front rather than silently redesigned,
 *   - a base belonging to someone else is refused,
 *   - and an accepted job says it understood.
 */

const { mockConfig, genDb, credits, generation, listing } = vi.hoisted(() => ({
  mockConfig: {
    pinningSystemKey: 'system-key-for-tests',
    claudeApiKey: 'k',
    claudeModel: 'claude-opus-5',
    claudeSocialModel: '',
    maxJobsPerUserPerHour: 10,
    freeGenerationsPerUser: 0,
    generationCostFula: 100,
    generationCostFulaWithTracking: 150,
  },
  genDb: {
    isGenerationId: (id: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    createGeneration: vi.fn(async () => 'job-1'),
    getGeneration: vi.fn(async (): Promise<any> => null),
    getGenerationsByUser: vi.fn(async () => ({ generations: [], total: 0 })),
    countRecentJobsByUser: vi.fn(async () => 0),
    countFreeCompletedGenerations: vi.fn(async () => 0),
    findRevisionBase: vi.fn(async (): Promise<any> => null),
  },
  credits: {
    deductCredits: vi.fn(async (): Promise<any> => ({ success: true })),
    refundCredits: vi.fn(async (): Promise<any> => ({ success: true })),
  },
  generation: { startGeneration: vi.fn(() => true) },
  listing: { ensureListingSummary: vi.fn(async () => null) },
}));

vi.mock('../src/config/index.js', () => ({ config: mockConfig }));
vi.mock('../src/middleware/jwtValidator.js', () => ({
  jwtValidatorMiddleware: async (c: any, next: any) => {
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('userId', auth.slice(7));
    c.set('userToken', auth.slice(7));
    await next();
  },
}));
vi.mock('../src/database/postgres.js', () => genDb);
vi.mock('../src/services/creditService.js', () => credits);
vi.mock('../src/services/generationService.js', () => generation);
vi.mock('../src/services/directoryListing.js', () => listing);
vi.mock('../src/database/directory_postgres.js', () => ({
  getGroupListingRow: vi.fn(async (): Promise<any> => null),
  setListed: vi.fn(async () => true),
  setListedForGroup: vi.fn(async () => true),
  setListingDetailsForGroup: vi.fn(async () => undefined),
  setListingName: vi.fn(async () => undefined),
  setListingUrl: vi.fn(async () => undefined),
}));

import { generateRoutes } from '../src/routes/generate.js';

const app = new Hono();
app.route('/api/v1', generateRoutes);

const OWNER = 'user-1';
const BASE_ID = '11111111-2222-4333-8444-555555555555';
const BASE_CID = 'bafybeibasecidbasecidbasecidbasecidbasecidbasecid';

const PROMPT = [
  'User request:',
  'Website Name: Aurora Studio',
  'Category: Corporation',
  'Palette: Warm',
  '',
  'A studio site for Aurora.',
].join('\n');

const ASSETS = [
  { fileName: 'hero.png', type: 'image', url: 'https://gw/ipfs/cid-a' },
];

function baseRow(over: Record<string, unknown> = {}) {
  return {
    id: BASE_ID,
    prompt: PROMPT,
    assets: ASSETS,
    files: [{ path: 'index.html', content: '<h1>Aurora</h1>' }],
    resultCid: BASE_CID,
    gatewayUrl: `https://gw/ipfs/${BASE_CID}`,
    enableTracking: false,
    ...over,
  };
}

function generate(body: Record<string, unknown>) {
  return app.request('/api/v1/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${OWNER}`,
    },
    body: JSON.stringify({
      prompt: PROMPT,
      assets: ASSETS,
      enable_tracking: false,
      pipeline_version: 2,
      listed: false,
      listing_name: 'aurora',
      listing_group: 'tag-1',
      ...body,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  genDb.countRecentJobsByUser.mockResolvedValue(0 as any);
  genDb.countFreeCompletedGenerations.mockResolvedValue(0 as any);
  genDb.createGeneration.mockResolvedValue('job-1' as any);
  credits.deductCredits.mockResolvedValue({ success: true } as any);
});

describe('a generation with no base is unaffected', () => {
  it('never looks for a revision base and reports itself as fresh', async () => {
    const res = await generate({});
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ mode: 'fresh' });
    expect(genDb.findRevisionBase).not.toHaveBeenCalled();
    // Fresh generations are still charged and still queued.
    expect(credits.deductCredits).toHaveBeenCalled();
    expect(generation.startGeneration).toHaveBeenCalled();
    // The base columns stay null on an ordinary build.
    const args = genDb.createGeneration.mock.calls[0];
    expect(args[10]).toBeNull();
    expect(args[11]).toBeNull();
  });
});

describe('an edit that asks for nothing', () => {
  it('returns the existing site, free, without creating a job', async () => {
    genDb.findRevisionBase.mockResolvedValue(baseRow() as any);

    const res = await generate({ base_cid: BASE_CID, revision_request: '' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: 'unchanged',
      resultCid: BASE_CID,
      gatewayUrl: `https://gw/ipfs/${BASE_CID}`,
    });
    expect(credits.deductCredits).not.toHaveBeenCalled();
    expect(genDb.createGeneration).not.toHaveBeenCalled();
    expect(generation.startGeneration).not.toHaveBeenCalled();
  });

  it('works for a site generated BEFORE the source was stored', async () => {
    // The whole point of ordering the no-op check first: every site the
    // user owns today has no stored source, and "change nothing" is
    // answerable without it.
    genDb.findRevisionBase.mockResolvedValue(baseRow({ files: [] }) as any);

    const res = await generate({ base_cid: BASE_CID, revision_request: '' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'unchanged' });
    expect(credits.deductCredits).not.toHaveBeenCalled();
  });

  it('sees through the legacy client constraints block', async () => {
    const legacyPrompt = [
      '=== SYSTEM CONSTRAINTS (auto-added, do not repeat) ===',
      'Output budget: under 40KB.',
      '=== END SYSTEM CONSTRAINTS ===',
      '',
      PROMPT,
    ].join('\n');
    genDb.findRevisionBase.mockResolvedValue(
      baseRow({ prompt: legacyPrompt }) as any
    );

    const res = await generate({ base_cid: BASE_CID, revision_request: '' });
    expect(res.status).toBe(200);
  });

  it('is NOT unchanged when the tracking setting moved', async () => {
    genDb.findRevisionBase.mockResolvedValue(baseRow() as any);

    const res = await generate({
      base_cid: BASE_CID,
      revision_request: '',
      enable_tracking: true,
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ mode: 'revision' });
  });

  it('is NOT unchanged when a setting moved', async () => {
    genDb.findRevisionBase.mockResolvedValue(baseRow() as any);

    const res = await generate({
      base_cid: BASE_CID,
      revision_request: '',
      prompt: PROMPT.replace('Palette: Warm', 'Palette: Cold'),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ mode: 'revision' });
  });
});

describe('an edit that asks for something', () => {
  it('is accepted as a revision and records what to edit', async () => {
    genDb.findRevisionBase.mockResolvedValue(baseRow() as any);

    const res = await generate({
      base_cid: BASE_CID,
      revision_request: 'Make the headline bigger',
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ mode: 'revision' });
    const args = genDb.createGeneration.mock.calls[0];
    // Resolved id, never the client's CID — the worker must not re-derive
    // ownership from client input.
    expect(args[10]).toBe(BASE_ID);
    expect(args[11]).toBe('Make the headline bigger');
    expect(genDb.findRevisionBase).toHaveBeenCalledWith(BASE_CID, OWNER);
  });

  it('is refused, unpaid, when the site has no stored source', async () => {
    genDb.findRevisionBase.mockResolvedValue(baseRow({ files: [] }) as any);

    const res = await generate({
      base_cid: BASE_CID,
      revision_request: 'Make the headline bigger',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'BASE_SOURCE_UNAVAILABLE',
    });
    expect(credits.deductCredits).not.toHaveBeenCalled();
    expect(generation.startGeneration).not.toHaveBeenCalled();
  });

  it('is refused, unpaid, when the base is not the caller’s', async () => {
    // A CID is derived from content, so two accounts can share one. The
    // lookup is user-scoped and returns nothing here.
    genDb.findRevisionBase.mockResolvedValue(null as any);

    const res = await generate({
      base_cid: BASE_CID,
      revision_request: 'Make the headline bigger',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'BASE_NOT_FOUND' });
    expect(credits.deductCredits).not.toHaveBeenCalled();
    expect(generation.startGeneration).not.toHaveBeenCalled();
  });
});
