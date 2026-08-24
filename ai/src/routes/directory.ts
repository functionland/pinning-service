/**
 * Public website directory ("yellow pages").
 *
 *   GET  /api/v1/directory              — public, paginated listing
 *   GET  /api/v1/directory/categories   — public, filter options
 *   POST /api/v1/directory/:id/report   — public, rate-limited abuse report
 *   GET  /api/v1/directory/admin/reports          — SYSTEM_KEY
 *   POST /api/v1/directory/admin/:id/delist       — SYSTEM_KEY
 *   POST /api/v1/directory/admin/categories       — SYSTEM_KEY
 *   DELETE /api/v1/directory/admin/categories/:slug — SYSTEM_KEY
 *
 * The owner-facing toggle lives in `generate.ts` instead, because that
 * router already carries the JWT middleware and the ownership check.
 *
 * SAFETY NOTE: `GET /directory` is the only unauthenticated ROW-LEVEL
 * read in this service (the pre-existing public endpoints are
 * aggregate-only counts). Its visibility filter is centralised in
 * `listDirectory` so it cannot be forgotten at a call site.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config/index.js';
import { isGenerationId } from '../database/postgres.js';
import {
  countRecentReportsByIp,
  createReport,
  deactivateCategory,
  getActiveCategories,
  isPubliclyListed,
  listDirectory,
  listReports,
  resolveReports,
  setAdminDelisted,
  upsertCategory,
} from '../database/directory_postgres.js';

export const directoryPublicRoutes = new Hono();

/** Reports allowed from one IP per day. */
const MAX_REPORTS_PER_IP_PER_DAY = 20;

/**
 * Is this a link we are willing to publish on the public directory?
 *
 * The stable share link is the website group's IPNS front door, which
 * only the CLIENT knows — the pointer lives in the user's own encrypted
 * manifest and is published to w3name client-side. So the client
 * supplies it, which means an attacker can supply it too.
 *
 * A directory entry is a name plus a link on a page other people read.
 * Accepting an arbitrary URL would let anyone publish a phishing target
 * under an innocuous name and borrow this site's credibility to do it.
 * So the shape is pinned exactly rather than sanity-checked: https, the
 * known host, and the front door's own `/w/<name>` path. Anything else is
 * ignored and the entry keeps its gateway URL.
 */
export function isAllowedListingUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // No credentials, no port, no query, no fragment — the front door has
  // none of those, and each is a way to dress a link up as something it
  // is not (`https://fxfiles.top@evil.example`, `?next=…`, and so on).
  if (url.username || url.password || url.port) return false;
  if (url.search || url.hash) return false;
  if (url.hostname !== 'fxfiles.top') return false;
  // /w/<ipns-name>, e.g. k51qzi5uqu5d… — nothing after it.
  return /^\/w\/[A-Za-z0-9]{40,80}$/.test(url.pathname);
}

/** 60s cache on the public listing, mirroring the Go public-stats
 *  endpoint's shape: a directory page is not worth a DB round-trip per
 *  visitor, and the data changes at human speed. */
const LISTING_CACHE_MS = 60_000;

/**
 * Hard cap on cached pages.
 *
 * The cache key includes `page`, which is caller-controlled and has no
 * natural upper bound, so an unbounded Map is a free memory-growth lever
 * for anyone willing to walk `?page=1..1000000`. Insertion evicts the
 * oldest entry once the cap is reached — the working set for a real
 * directory is a handful of pages per category.
 */
const LISTING_CACHE_MAX_ENTRIES = 500;

/** Deepest page anyone can request. */
const MAX_PAGE = 1000;

const listingCache = new Map<string, { at: number; body: unknown }>();

function cacheListing(key: string, body: unknown): void {
  if (listingCache.size >= LISTING_CACHE_MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = listingCache.keys().next();
    if (!oldest.done) listingCache.delete(oldest.value);
  }
  listingCache.set(key, { at: Date.now(), body });
}

/** Drop the cached listing pages (admin delist, and test isolation). */
export function clearDirectoryCache(): void {
  listingCache.clear();
}

/**
 * Rate-limit identity for an anonymous caller.
 *
 * X-Forwarded-For is CLIENT-CONTROLLED. nginx is configured with
 * `$proxy_add_x_forwarded_for`, which APPENDS the real peer to whatever
 * the client sent — so the FIRST entry is whatever the caller claimed and
 * the LAST is the only one our own proxy wrote. Taking `[0]` would let an
 * attacker send a fresh fake address per request and never reach the
 * limit. Prefer `X-Real-IP` (nginx sets it to the true peer), and fall
 * back to the last XFF hop, never the first.
 */
function clientIpHash(
  realIp: string | undefined,
  forwardedFor: string | undefined
): string | null {
  const hops = forwardedFor
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = realIp?.trim() || (hops?.length ? hops[hops.length - 1] : null);
  if (!ip) return null;
  // Salted with the service's own secret so the stored value cannot be
  // reversed to an IP by anyone who reads the table.
  return createHash('sha256')
    .update(`${config.pinningSystemKey}:${ip}`)
    .digest('hex')
    .slice(0, 32);
}

// ============================================
// GET /directory/categories
// ============================================

directoryPublicRoutes.get('/directory/categories', async (c) => {
  const categories = await getActiveCategories();
  return c.json({
    categories: categories.map((cat) => ({
      slug: cat.slug,
      label: cat.label,
    })),
  });
});

// ============================================
// GET /directory
// ============================================

directoryPublicRoutes.get('/directory', async (c) => {
  // Clamped at both ends: a deep OFFSET is a scan nobody is browsing for.
  const page = Math.min(
    Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1),
    MAX_PAGE
  );
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') || '24', 10) || 24, 1),
    60
  );
  const rawCategory = c.req.query('category')?.trim().toLowerCase();

  // Only a category we actually offer may reach the query.
  let category: string | undefined;
  if (rawCategory) {
    const allowed = await getActiveCategories();
    if (!allowed.some((cat) => cat.slug === rawCategory)) {
      return c.json({ error: 'Unknown category', code: 'BAD_CATEGORY' }, 400);
    }
    category = rawCategory;
  }

  const cacheKey = `${category ?? '*'}|${page}|${limit}`;
  const hit = listingCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LISTING_CACHE_MS) {
    return c.json(hit.body as any);
  }

  const { entries, total } = await listDirectory({ category, page, limit });
  const body = {
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      category: e.category,
      url: e.gateway_url,
      cid: e.result_cid,
      publishedAt: e.completed_at,
    })),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
  cacheListing(cacheKey, body);
  return c.json(body);
});

// ============================================
// POST /directory/:id/report
// ============================================

const reportSchema = z.object({
  reason: z.enum([
    'spam',
    'scam',
    'malware',
    'adult',
    'illegal',
    'impersonation',
    'other',
  ]),
  details: z.string().max(1000).optional(),
});

directoryPublicRoutes.post('/directory/:id/report', async (c) => {
  const id = c.req.param('id');
  // Untrusted path parameter against a UUID column. Rejected here as
  // well as in the DB layer so the guard is visible at the boundary the
  // input actually crosses, and so a route test can prove it.
  if (!isGenerationId(id)) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  let body: z.infer<typeof reportSchema>;
  try {
    body = reportSchema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation error', details: error.errors }, 400);
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }

  // Only a currently-listed entry can be reported — otherwise this is a
  // free probe for whether an arbitrary generation id exists.
  if (!(await isPubliclyListed(id))) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  const ipHash = clientIpHash(
    c.req.header('x-real-ip'),
    c.req.header('x-forwarded-for')
  );
  if (ipHash) {
    const recent = await countRecentReportsByIp(ipHash, 24);
    if (recent >= MAX_REPORTS_PER_IP_PER_DAY) {
      return c.json(
        { error: 'Too many reports', code: 'RATE_LIMIT' },
        429
      );
    }
  }

  await createReport({
    id: randomUUID(),
    generationId: id,
    reason: body.reason,
    details: body.details ?? null,
    reporterIpHash: ipHash,
  });

  // A report NEVER auto-delists: that would hand any visitor a takedown
  // button. It queues the entry for a human.
  return c.json({ ok: true }, 202);
});

// ============================================
// Admin (SYSTEM_KEY header, same convention as the Go admin routes)
// ============================================

export const directoryAdminRoutes = new Hono();

// Scoped to the admin subtree, NOT '*'.
//
// This router is mounted at `/api/v1` alongside the authed generate
// routes. A `use('*', ...)` here runs for every request that reaches the
// router at that MOUNT PREFIX — which is every `/api/v1/*` path — so the
// guard would 403 the entire API (generate, status, ask, social) rather
// than just the admin endpoints. `tsc` cannot see that; the route test
// in `tests/directoryRoutes.test.ts` exists because of it.
directoryAdminRoutes.use('/directory/admin/*', async (c, next) => {
  const key = c.req.header('x-system-key');
  if (!key || key !== config.pinningSystemKey) {
    return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
  }
  await next();
});

directoryAdminRoutes.get('/directory/admin/reports', async (c) => {
  const onlyOpen = c.req.query('all') !== 'true';
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') || '100', 10) || 100, 1),
    500
  );
  const reports = await listReports({ onlyOpen, limit });
  return c.json({ reports });
});

directoryAdminRoutes.post('/directory/admin/:id/delist', async (c) => {
  const id = c.req.param('id');
  if (!isGenerationId(id)) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  const restore = c.req.query('restore') === 'true';
  const ok = await setAdminDelisted(id, !restore);
  if (!ok) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  if (!restore) await resolveReports(id);
  listingCache.clear();
  return c.json({ ok: true, delisted: !restore });
});

const categorySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits or -'),
  label: z.string().min(1).max(80),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

directoryAdminRoutes.post('/directory/admin/categories', async (c) => {
  let body: z.infer<typeof categorySchema>;
  try {
    body = categorySchema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation error', details: error.errors }, 400);
    }
    return c.json({ error: 'Invalid request body' }, 400);
  }
  await upsertCategory(body);
  return c.json({ ok: true });
});

directoryAdminRoutes.delete('/directory/admin/categories/:slug', async (c) => {
  // Soft delete: rows already tagged with this category keep rendering,
  // it just stops being offered to the model or the filter UI.
  const ok = await deactivateCategory(c.req.param('slug'));
  if (!ok) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ ok: true });
});

export default directoryPublicRoutes;
