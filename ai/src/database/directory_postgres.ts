/**
 * Public directory ("yellow pages") data access.
 *
 * Reads and writes the directory columns added to `ai_generations` by
 * migration 007, plus `directory_categories` and `directory_reports`.
 *
 * The public listing query is the ONLY query in this service that is
 * not scoped to a caller, so its filter is written once, here, and every
 * public route goes through it: listed AND not admin-delisted AND
 * completed. A row that fails any of those must never be reachable from
 * an unauthenticated endpoint.
 */

import { isGenerationId, query } from './postgres.js';

export interface DirectoryCategory {
  slug: string;
  label: string;
  sort_order: number;
}

export interface DirectoryEntry {
  id: string;
  name: string | null;
  description: string | null;
  category: string | null;
  gateway_url: string | null;
  result_cid: string | null;
  completed_at: string | null;
}

/** Categories the AI may choose from, in display order. */
export async function getActiveCategories(): Promise<DirectoryCategory[]> {
  const result = await query<DirectoryCategory>(
    `SELECT slug, label, sort_order
       FROM directory_categories
      WHERE active = TRUE
      ORDER BY sort_order ASC, label ASC`
  );
  return result.rows;
}

/**
 * One page of the public directory.
 *
 * `listed = TRUE AND delisted_by_admin = FALSE AND status = 'completed'`
 * is the whole visibility contract — see the module comment.
 */
export async function listDirectory(opts: {
  category?: string;
  page: number;
  limit: number;
}): Promise<{ entries: DirectoryEntry[]; total: number }> {
  const where: string[] = [
    'listed = TRUE',
    'delisted_by_admin = FALSE',
    "status = 'completed'",
    'result_cid IS NOT NULL',
  ];
  const params: any[] = [];
  if (opts.category) {
    params.push(opts.category);
    where.push(`listing_category = $${params.length}`);
  }
  const whereSql = where.join(' AND ');

  // One entry per WEBSITE, not per generation. Every regeneration is its
  // own `ai_generations` row, so without this the directory would show
  // five near-identical entries for a site generated five times — with
  // the older, superseded links among them. Rows with no group behave as
  // their own group.
  const groupKey = "COALESCE(listing_group, id::text)";

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM (SELECT DISTINCT ${groupKey} AS g
               FROM ai_generations
              WHERE ${whereSql}) t`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const offset = (opts.page - 1) * opts.limit;
  params.push(opts.limit, offset);
  const result = await query<DirectoryEntry>(
    `SELECT * FROM (
       SELECT DISTINCT ON (${groupKey})
              id,
              listing_name        AS name,
              listing_description AS description,
              listing_category    AS category,
              -- The stable IPNS front door when the client supplied one,
              -- else the raw per-generation gateway URL. The front door
              -- survives regeneration; gateway_url points at ONE build
              -- and goes stale as soon as the site is regenerated.
              COALESCE(listing_url, gateway_url) AS gateway_url,
              result_cid,
              completed_at
         FROM ai_generations
        WHERE ${whereSql}
        ORDER BY ${groupKey}, completed_at DESC NULLS LAST
     ) t
     ORDER BY completed_at DESC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { entries: result.rows, total };
}

/// True when the entry is currently visible in the public directory.
///
/// `id` comes straight from an UNAUTHENTICATED path parameter, so a
/// malformed value must answer "no" rather than reaching a UUID column
/// and raising `invalid input syntax for type uuid` (a 500 where 404 is
/// the honest answer).
export async function isPubliclyListed(id: string): Promise<boolean> {
  if (!isGenerationId(id)) return false;
  const result = await query<{ ok: boolean }>(
    `SELECT (listed AND NOT delisted_by_admin AND status = 'completed') AS ok
       FROM ai_generations WHERE id = $1`,
    [id]
  );
  return result.rows[0]?.ok === true;
}

/**
 * Flip a generation's listing flag. Owner-scoped: the WHERE clause is the
 * authorization check, so a mismatched caller updates zero rows rather
 * than someone else's listing.
 *
 * Returns false when nothing matched (wrong owner, or unknown id).
 */
export async function setListed(
  id: string,
  userId: string,
  listed: boolean
): Promise<boolean> {
  if (!isGenerationId(id)) return false;
  const result = await query(
    `UPDATE ai_generations
        SET listed = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND (user_id = $3 OR user_email = $3)`,
    [listed, id, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Client-supplied display name for the listing. */
export async function setListingName(
  id: string,
  name: string | null
): Promise<void> {
  if (!isGenerationId(id)) return;
  await query(
    `UPDATE ai_generations SET listing_name = $1 WHERE id = $2`,
    [name, id]
  );
}

/**
 * Stable share link for the listing — the group's IPNS front door.
 *
 * The caller MUST validate the URL first (`isAllowedListingUrl` in
 * routes/directory.ts). This value is published verbatim on a public
 * page, so storing an unvalidated one would turn the directory into
 * somebody else's redirector.
 */
export async function setListingUrl(
  id: string,
  url: string | null
): Promise<void> {
  if (!isGenerationId(id)) return;
  await query(
    `UPDATE ai_generations SET listing_url = $1 WHERE id = $2`,
    [url, id]
  );
}

/**
 * Store the AI-generated blurb + category, stamping `listing_generated_at`.
 *
 * That stamp is the billing guard: a user toggling listing off and back
 * on must not pay for a second AI call, so callers check
 * [needsListingSummary] first and this is written exactly once.
 */
export async function saveListingSummary(
  id: string,
  description: string,
  category: string
): Promise<void> {
  await query(
    `UPDATE ai_generations
        SET listing_description = $1,
            listing_category = $2,
            listing_generated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $3`,
    [description, category, id]
  );
}

/** True when this generation has never had its listing summary made. */
export async function needsListingSummary(id: string): Promise<boolean> {
  const result = await query<{ pending: boolean }>(
    `SELECT (listing_generated_at IS NULL) AS pending
       FROM ai_generations WHERE id = $1`,
    [id]
  );
  return result.rows[0]?.pending === true;
}

// ============================================
// Moderation
// ============================================

export async function createReport(opts: {
  id: string;
  generationId: string;
  reason: string;
  details?: string | null;
  reporterIpHash?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO directory_reports (id, generation_id, reason, details, reporter_ip_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      opts.id,
      opts.generationId,
      opts.reason,
      opts.details ?? null,
      opts.reporterIpHash ?? null,
    ]
  );
}

/** Reports from one IP hash in the last [hours] — the rate-limit input. */
export async function countRecentReportsByIp(
  ipHash: string,
  hours: number
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM directory_reports
      WHERE reporter_ip_hash = $1
        AND created_at > CURRENT_TIMESTAMP - ($2 || ' hours')::INTERVAL`,
    [ipHash, String(hours)]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export interface DirectoryReportRow {
  id: string;
  generation_id: string;
  reason: string;
  details: string | null;
  resolved: boolean;
  created_at: string;
  listing_name: string | null;
  gateway_url: string | null;
  delisted_by_admin: boolean;
}

export async function listReports(opts: {
  onlyOpen: boolean;
  limit: number;
}): Promise<DirectoryReportRow[]> {
  const result = await query<DirectoryReportRow>(
    `SELECT r.id, r.generation_id, r.reason, r.details, r.resolved, r.created_at,
            g.listing_name, g.gateway_url, g.delisted_by_admin
       FROM directory_reports r
       LEFT JOIN ai_generations g ON g.id = r.generation_id
      ${opts.onlyOpen ? 'WHERE r.resolved = FALSE' : ''}
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [opts.limit]
  );
  return result.rows;
}

/**
 * Remove (or restore) a listing as an admin.
 *
 * DELISTS ONLY. The generated site is content-addressed and pinned to
 * IPFS, so its CID stays reachable by anyone holding the link — the
 * directory page says so explicitly rather than implying a takedown
 * power this system does not have.
 */
export async function setAdminDelisted(
  id: string,
  delisted: boolean
): Promise<boolean> {
  if (!isGenerationId(id)) return false;
  const result = await query(
    `UPDATE ai_generations
        SET delisted_by_admin = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
    [delisted, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function resolveReports(generationId: string): Promise<void> {
  await query(
    `UPDATE directory_reports SET resolved = TRUE WHERE generation_id = $1`,
    [generationId]
  );
}

// ============================================
// Category administration
// ============================================

export async function upsertCategory(opts: {
  slug: string;
  label: string;
  sortOrder?: number;
  active?: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO directory_categories (slug, label, sort_order, active)
     VALUES ($1, $2, COALESCE($3, 100), COALESCE($4, TRUE))
     ON CONFLICT (slug) DO UPDATE
        SET label = EXCLUDED.label,
            sort_order = EXCLUDED.sort_order,
            active = EXCLUDED.active`,
    [opts.slug, opts.label, opts.sortOrder ?? null, opts.active ?? null]
  );
}

/**
 * Retire a category. Deliberately a soft delete: rows already tagged with
 * it keep rendering, they just stop being offered to the model.
 */
export async function deactivateCategory(slug: string): Promise<boolean> {
  const result = await query(
    `UPDATE directory_categories SET active = FALSE WHERE slug = $1`,
    [slug]
  );
  return (result.rowCount ?? 0) > 0;
}
