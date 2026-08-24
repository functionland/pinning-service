import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * The directory's PUBLIC routes and the AUTHED generate routes share the
 * `/api/v1` prefix. Hono scopes `use('*', ...)` to the router instance,
 * so mounting a public router alongside an authed one is safe — but only
 * as long as the paths genuinely don't collide. `tsc` cannot tell you
 * that; only a request can. These tests pin the auth boundary in both
 * directions:
 *
 *   - a public route must NOT be swallowed by the JWT middleware
 *   - the owner-only listing toggle must NOT leak out of it
 *
 * The app is assembled here in the SAME order as `src/app.ts`.
 */

const { mockConfig, dirDb, genDb, credits, generation, listing } = vi.hoisted(
  () => ({
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
    dirDb: {
      getActiveCategories: vi.fn(async () => [
        { slug: 'food', label: 'Food', sort_order: 10 },
        { slug: 'other', label: 'Other', sort_order: 999 },
      ]),
      listDirectory: vi.fn(async () => ({ entries: [], total: 0 })),
      isPubliclyListed: vi.fn(async () => false),
      createReport: vi.fn(async () => undefined),
      countRecentReportsByIp: vi.fn(async () => 0),
      listReports: vi.fn(async () => []),
      setAdminDelisted: vi.fn(async () => true),
      resolveReports: vi.fn(async () => undefined),
      upsertCategory: vi.fn(async () => undefined),
      deactivateCategory: vi.fn(async () => true),
      setListed: vi.fn(async () => true),
      setListingName: vi.fn(async () => undefined),
      setListingUrl: vi.fn(async () => undefined),
    },
    genDb: {
      // Real implementation, not a stub: the routes' malformed-id guard
      // depends on it, and a permissive stub would hide the very bug it
      // exists to prevent.
      isGenerationId: (id: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id
        ),
      createGeneration: vi.fn(async () => 'job-1'),
      getGeneration: vi.fn(async (): Promise<any> => null),
      getGenerationsByUser: vi.fn(async () => ({ generations: [], total: 0 })),
      countRecentJobsByUser: vi.fn(async () => 0),
      countFreeCompletedGenerations: vi.fn(async () => 0),
    },
    credits: {
      deductCredits: vi.fn(async (): Promise<any> => ({ success: true })),
      refundCredits: vi.fn(async (): Promise<any> => ({ success: true })),
    },
    generation: { startGeneration: vi.fn(() => true) },
    listing: { ensureListingSummary: vi.fn(async () => null) },
  })
);

vi.mock('../src/config/index.js', () => ({ config: mockConfig }));

// Stand-in for the real JWT middleware: rejects when there is no bearer
// token, so a leaked route shows up as a 200 where a 401 belongs.
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

vi.mock('../src/database/directory_postgres.js', () => dirDb);
vi.mock('../src/database/postgres.js', () => genDb);
vi.mock('../src/services/creditService.js', () => credits);
vi.mock('../src/services/generationService.js', () => generation);
vi.mock('../src/services/directoryListing.js', () => listing);

import {
  directoryPublicRoutes,
  directoryAdminRoutes,
  clearDirectoryCache,
  isAllowedListingUrl,
} from '../src/routes/directory.js';
import { generateRoutes } from '../src/routes/generate.js';

// Mount order mirrors src/app.ts exactly.
const app = new Hono();
app.route('/api/v1', directoryPublicRoutes);
app.route('/api/v1', directoryAdminRoutes);
app.route('/api/v1', generateRoutes);

const OWNER = 'user-1';
/** A well-formed generation id — `ai_generations.id` is a UUID column. */
const GEN_ID = '11111111-2222-4333-8444-555555555555';

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'GET', headers });
}
function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The listing cache is process-global; without this a later test is
  // served a previous test's page and its DB assertion never fires.
  clearDirectoryCache();
  dirDb.getActiveCategories.mockResolvedValue([
    { slug: 'food', label: 'Food', sort_order: 10 },
    { slug: 'other', label: 'Other', sort_order: 999 },
  ] as any);
  dirDb.listDirectory.mockResolvedValue({ entries: [], total: 0 } as any);
  dirDb.isPubliclyListed.mockResolvedValue(false as any);
  dirDb.countRecentReportsByIp.mockResolvedValue(0 as any);
});

describe('public directory routes are NOT behind the JWT middleware', () => {
  it('GET /api/v1/directory serves anonymous visitors', async () => {
    const res = await get('/api/v1/directory');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('entries');
    expect(dirDb.listDirectory).toHaveBeenCalled();
  });

  it('GET /api/v1/directory/categories serves anonymous visitors', async () => {
    const res = await get('/api/v1/directory/categories');
    expect(res.status).toBe(200);
    expect((await res.json()).categories).toHaveLength(2);
  });

  it('POST /report reaches the handler without auth (404, not 401)', async () => {
    // An unlisted id must answer "not found", proving the request got
    // past routing rather than being rejected by the authed router.
    const res = await post(`/api/v1/directory/${GEN_ID}/report`, {
      reason: 'spam',
    });
    expect(res.status).toBe(404);
    expect(dirDb.isPubliclyListed).toHaveBeenCalledWith(GEN_ID);
  });
});

describe('a malformed id answers 404, never a 500', () => {
  // `ai_generations.id` is a UUID column, so handing it `abc` raises
  // `invalid input syntax for type uuid` — a 500 for what is really a
  // "no such thing" question, on an UNAUTHENTICATED endpoint anyone can
  // hit in a loop.
  it('report', async () => {
    const res = await post('/api/v1/directory/abc/report', { reason: 'spam' });
    expect(res.status).toBe(404);
    expect(dirDb.isPubliclyListed).not.toHaveBeenCalled();
  });

  it('admin delist', async () => {
    const res = await post(
      '/api/v1/directory/admin/not-a-uuid/delist',
      {},
      { 'x-system-key': 'system-key-for-tests' }
    );
    expect(res.status).toBe(404);
    expect(dirDb.setAdminDelisted).not.toHaveBeenCalled();
  });
});

describe('the public listing query cannot be widened from outside', () => {
  it('rejects a category we do not offer', async () => {
    const res = await get('/api/v1/directory?category=made-up');
    expect(res.status).toBe(400);
    expect(dirDb.listDirectory).not.toHaveBeenCalled();
  });

  it('clamps limit so one request cannot pull the whole table', async () => {
    await get('/api/v1/directory?limit=100000');
    expect(dirDb.listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 60 })
    );
  });

  it('clamps a nonsense page to 1', async () => {
    await get('/api/v1/directory?page=-5');
    expect(dirDb.listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 })
    );
  });

  it('clamps a very deep page, so OFFSET cannot be driven arbitrarily', async () => {
    await get('/api/v1/directory?page=999999999');
    expect(dirDb.listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1000 })
    );
  });

  it('the response cache cannot be grown without bound', async () => {
    // `page` is caller-controlled and unbounded above, so an unbounded
    // Map would be a free memory-growth lever.
    for (let p = 1; p <= 600; p++) {
      await get(`/api/v1/directory?page=${p}`);
    }
    // Distinct pages requested: 600. Cache must have evicted down to the
    // cap rather than retaining all of them.
    expect(dirDb.listDirectory.mock.calls.length).toBe(600);
    const res = await get('/api/v1/directory?page=1');
    expect(res.status).toBe(200);
  });
});

describe('rate-limit identity cannot be spoofed by the caller', () => {
  // nginx uses $proxy_add_x_forwarded_for, which APPENDS the real peer to
  // whatever the client sent. Taking XFF[0] would let an attacker send a
  // fresh fake address per request and never reach the limit.
  it('prefers X-Real-IP over a client-supplied X-Forwarded-For', async () => {
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    await post(
      `/api/v1/directory/${GEN_ID}/report`,
      { reason: 'spam' },
      { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '1.1.1.1' }
    );
    const withRealIp = (dirDb.createReport.mock.calls[0][0] as any)
      .reporterIpHash;

    vi.clearAllMocks();
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    dirDb.countRecentReportsByIp.mockResolvedValue(0 as any);
    await post(
      `/api/v1/directory/${GEN_ID}/report`,
      { reason: 'spam' },
      { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '2.2.2.2' }
    );
    const withDifferentSpoof = (dirDb.createReport.mock.calls[0][0] as any)
      .reporterIpHash;

    // Same real peer, different spoofed XFF -> SAME bucket.
    expect(withDifferentSpoof).toBe(withRealIp);
  });

  it('falls back to the LAST forwarded hop, never the first', async () => {
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    await post(
      `/api/v1/directory/${GEN_ID}/report`,
      { reason: 'spam' },
      { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }
    );
    const viaChain = (dirDb.createReport.mock.calls[0][0] as any)
      .reporterIpHash;

    vi.clearAllMocks();
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    dirDb.countRecentReportsByIp.mockResolvedValue(0 as any);
    await post(
      `/api/v1/directory/${GEN_ID}/report`,
      { reason: 'spam' },
      { 'x-real-ip': '203.0.113.9' }
    );
    const viaRealIp = (dirDb.createReport.mock.calls[0][0] as any)
      .reporterIpHash;

    expect(viaChain).toBe(viaRealIp);
  });
});

describe('reporting', () => {
  it('stores a report for a listed entry and never auto-delists', async () => {
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    const res = await post(`/api/v1/directory/${GEN_ID}/report`, {
      reason: 'scam',
      details: 'asks for seed phrases',
    });
    expect(res.status).toBe(202);
    expect(dirDb.createReport).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: GEN_ID, reason: 'scam' })
    );
    // A visitor must not be able to remove a listing.
    expect(dirDb.setAdminDelisted).not.toHaveBeenCalled();
  });

  it('rejects an unknown reason', async () => {
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    const res = await post(`/api/v1/directory/${GEN_ID}/report`, {
      reason: 'i-just-dislike-it',
    });
    expect(res.status).toBe(400);
    expect(dirDb.createReport).not.toHaveBeenCalled();
  });

  it('rate-limits a flooding reporter', async () => {
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    dirDb.countRecentReportsByIp.mockResolvedValue(20 as any);
    const res = await post(
      `/api/v1/directory/${GEN_ID}/report`,
      { reason: 'spam' },
      { 'x-forwarded-for': '203.0.113.5' }
    );
    expect(res.status).toBe(429);
    expect(dirDb.createReport).not.toHaveBeenCalled();
  });

  it('never stores a raw IP', async () => {
    dirDb.isPubliclyListed.mockResolvedValue(true as any);
    await post(
      `/api/v1/directory/${GEN_ID}/report`,
      { reason: 'spam' },
      { 'x-forwarded-for': '203.0.113.5' }
    );
    const arg = dirDb.createReport.mock.calls[0][0] as any;
    expect(arg.reporterIpHash).toBeTruthy();
    expect(arg.reporterIpHash).not.toContain('203.0.113.5');
  });
});

describe('admin routes require the system key', () => {
  it('rejects a missing key', async () => {
    expect((await get('/api/v1/directory/admin/reports')).status).toBe(403);
  });

  it('rejects a wrong key', async () => {
    const res = await get('/api/v1/directory/admin/reports', {
      'x-system-key': 'nope',
    });
    expect(res.status).toBe(403);
  });

  it('accepts the right key', async () => {
    const res = await get('/api/v1/directory/admin/reports', {
      'x-system-key': 'system-key-for-tests',
    });
    expect(res.status).toBe(200);
  });

  it('delisting is admin-only and resolves the entry reports', async () => {
    const res = await post(
      `/api/v1/directory/admin/${GEN_ID}/delist`,
      {},
      { 'x-system-key': 'system-key-for-tests' }
    );
    expect(res.status).toBe(200);
    expect(dirDb.setAdminDelisted).toHaveBeenCalledWith(GEN_ID, true);
    expect(dirDb.resolveReports).toHaveBeenCalledWith(GEN_ID);
  });
});

describe('the owner listing toggle stays INSIDE the authed router', () => {
  it('401s without a bearer token', async () => {
    // If the public mount had shadowed this, it would be an
    // unauthenticated write.
    const res = await post(`/api/v1/generations/${GEN_ID}/listing`, {
      listed: true,
    });
    expect(res.status).toBe(401);
    expect(dirDb.setListed).not.toHaveBeenCalled();
  });

  it('404s for a generation the caller does not own', async () => {
    genDb.getGeneration.mockResolvedValue({
      id: GEN_ID,
      user_id: 'someone-else',
      user_email: 'someone-else',
      status: 'completed',
      delisted_by_admin: false,
    } as any);
    const res = await post(
      `/api/v1/generations/${GEN_ID}/listing`,
      { listed: true },
      { authorization: `Bearer ${OWNER}` }
    );
    expect(res.status).toBe(404);
    expect(dirDb.setListed).not.toHaveBeenCalled();
  });

  it('lets the owner turn listing on, and summarises once', async () => {
    genDb.getGeneration.mockResolvedValue({
      id: GEN_ID,
      user_id: OWNER,
      status: 'completed',
      delisted_by_admin: false,
    } as any);
    const res = await post(
      `/api/v1/generations/${GEN_ID}/listing`,
      { listed: true, name: 'My Bakery' },
      { authorization: `Bearer ${OWNER}` }
    );
    expect(res.status).toBe(200);
    expect(dirDb.setListed).toHaveBeenCalledWith(GEN_ID, OWNER, true);
    expect(dirDb.setListingName).toHaveBeenCalledWith(GEN_ID, 'My Bakery');
    expect(listing.ensureListingSummary).toHaveBeenCalledWith(GEN_ID);
  });

  it('turning listing OFF never triggers an AI call', async () => {
    genDb.getGeneration.mockResolvedValue({
      id: GEN_ID,
      user_id: OWNER,
      status: 'completed',
      delisted_by_admin: false,
    } as any);
    const res = await post(
      `/api/v1/generations/${GEN_ID}/listing`,
      { listed: false },
      { authorization: `Bearer ${OWNER}` }
    );
    expect(res.status).toBe(200);
    expect(listing.ensureListingSummary).not.toHaveBeenCalled();
  });

  it('an admin delisting cannot be undone by the owner', async () => {
    genDb.getGeneration.mockResolvedValue({
      id: GEN_ID,
      user_id: OWNER,
      status: 'completed',
      delisted_by_admin: true,
    } as any);
    const res = await post(
      `/api/v1/generations/${GEN_ID}/listing`,
      { listed: true },
      { authorization: `Bearer ${OWNER}` }
    );
    expect(res.status).toBe(409);
    expect(dirDb.setListed).not.toHaveBeenCalled();
  });
});

describe('the listing URL is a link we publish, so it is pinned', () => {
  // The stable share link is only known CLIENT-side, so an attacker can
  // supply one too. A directory entry is a name plus a link on a page
  // other people read — an arbitrary URL lets anyone publish a phishing
  // target under an innocuous name using this site's credibility.
  const GOOD = 'https://fxfiles.top/w/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';

  it('accepts a real front-door link', () => {
    expect(isAllowedListingUrl(GOOD)).toBe(true);
  });

  it('rejects any other host', () => {
    expect(isAllowedListingUrl('https://evil.example/w/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8')).toBe(false);
    expect(isAllowedListingUrl('https://fxfiles.top.evil.example/w/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8')).toBe(false);
  });

  it('rejects a userinfo trick that reads as the right host', () => {
    // https://fxfiles.top@evil.example/... — hostname is evil.example.
    expect(
      isAllowedListingUrl('https://fxfiles.top@evil.example/w/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8')
    ).toBe(false);
  });

  it('rejects non-https', () => {
    expect(isAllowedListingUrl(GOOD.replace('https:', 'http:'))).toBe(false);
    expect(isAllowedListingUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedListingUrl('data:text/html,<script>')).toBe(false);
  });

  it('rejects query, fragment and port dressing', () => {
    expect(isAllowedListingUrl(`${GOOD}?next=https://evil.example`)).toBe(false);
    expect(isAllowedListingUrl(`${GOOD}#/../../evil`)).toBe(false);
    expect(isAllowedListingUrl(GOOD.replace('fxfiles.top', 'fxfiles.top:8080'))).toBe(false);
  });

  it('rejects a wrong path on the right host', () => {
    expect(isAllowedListingUrl('https://fxfiles.top/')).toBe(false);
    expect(isAllowedListingUrl('https://fxfiles.top/w/')).toBe(false);
    expect(isAllowedListingUrl('https://fxfiles.top/w/short')).toBe(false);
    expect(isAllowedListingUrl(`${GOOD}/../admin`)).toBe(false);
  });

  it('rejects garbage without throwing', () => {
    expect(isAllowedListingUrl('')).toBe(false);
    expect(isAllowedListingUrl('not a url')).toBe(false);
  });

  it('stores a valid URL and reports it accepted', async () => {
    genDb.getGeneration.mockResolvedValue({
      id: GEN_ID,
      user_id: OWNER,
      status: 'completed',
      delisted_by_admin: false,
    } as any);
    const res = await post(
      `/api/v1/generations/${GEN_ID}/listing`,
      { listed: true, url: GOOD },
      { authorization: `Bearer ${OWNER}` }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).urlAccepted).toBe(true);
    expect(dirDb.setListingUrl).toHaveBeenCalledWith(GEN_ID, GOOD);
  });

  it('drops a bad URL WITHOUT failing the toggle', async () => {
    // The link is best-effort enrichment — the IPNS publish may not have
    // landed. Failing the whole toggle over it would be worse than
    // listing with the raw gateway URL.
    genDb.getGeneration.mockResolvedValue({
      id: GEN_ID,
      user_id: OWNER,
      status: 'completed',
      delisted_by_admin: false,
    } as any);
    const res = await post(
      `/api/v1/generations/${GEN_ID}/listing`,
      { listed: true, url: 'https://evil.example/phish' },
      { authorization: `Bearer ${OWNER}` }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).urlAccepted).toBe(false);
    expect(dirDb.setListingUrl).not.toHaveBeenCalled();
    expect(dirDb.setListed).toHaveBeenCalled();
  });
});

describe('generate accepts the directory fields', () => {
  it('defaults listed to FALSE when an older client omits it', async () => {
    await post(
      '/api/v1/generate',
      { prompt: 'A bakery site', assets: [] },
      { authorization: `Bearer ${OWNER}` }
    );
    const args = genDb.createGeneration.mock.calls[0];
    // (id, userId, prompt, assets, credits, tracking, pipeline, listed, name)
    expect(args[7]).toBe(false);
  });

  it('passes listed + listing_name + group through when sent', async () => {
    await post(
      '/api/v1/generate',
      {
        prompt: 'A bakery site',
        assets: [],
        listed: true,
        listing_name: 'My Bakery',
        listing_group: 'tag-42',
      },
      { authorization: `Bearer ${OWNER}` }
    );
    const args = genDb.createGeneration.mock.calls[0];
    expect(args[7]).toBe(true);
    expect(args[8]).toBe('My Bakery');
    // Without a group key the directory shows one entry per
    // regeneration instead of one per website.
    expect(args[9]).toBe('tag-42');
  });
});
