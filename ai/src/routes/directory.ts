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

/** 60s cache on the public listing, mirroring the Go public-stats
 *  endpoint's shape: a directory page is not worth a DB round-trip per
 *  visitor, and the data changes at human speed. */
const LISTING_CACHE_MS = 60_000;
const listingCache = new Map<string, { at: number; body: unknown }>();

function clientIpHash(ipHeader: string | undefined): string | null {
  const ip = ipHeader?.split(',')[0]?.trim();
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
  const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1);
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
  listingCache.set(cacheKey, { at: Date.now(), body });
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
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip')
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

directoryAdminRoutes.use('*', async (c, next) => {
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
