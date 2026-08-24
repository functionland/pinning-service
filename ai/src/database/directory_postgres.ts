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
 *
 * VISIBILITY IS A PROPERTY OF THE WEBSITE, NOT OF ONE GENERATION.
 * ---------------------------------------------------------------
 * Every regeneration writes a NEW `ai_generations` row sharing the
 * website's `listing_group`, so a site that has been generated three
 * times has three rows carrying three independent `listed` /
 * `delisted_by_admin` flags. Evaluating those per row and only then
 * collapsing to one entry per group is wrong in both directions:
 *
 *   - Withdrawal fails. Turning the switch off wrote one row; an older
 *     row still said `listed = TRUE`, so the site stayed in the
 *     directory and the user could not take it out.
 *   - Takedown fails. Admin removal wrote one row; the query fell
 *     through to the next-newest listed row and the site REAPPEARED,
 *     while the report that prompted the removal was marked resolved.
 *
 * So both flags are folded across the group first (`bool_or`), and only
 * a group that is listed and has no admin-removed build is visible. The
 * entry then shows the newest LISTED build, because the AI summary and
 * the stable link are written to rows that were listed.
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
  // One entry per WEBSITE, not per generation. Rows with no group behave
  // as their own group, so a pre-group generation is still one entry.
  const groupKey = 'COALESCE(listing_group, id::text)';

  // Every build of the site that could carry a visibility flag. Not
  // filtered by `listed` — a row that is admin-removed but no longer
  // listed must still veto the group, or a takedown could be undone by
  // toggling the switch.
  const base = `SELECT *, ${groupKey} AS grp
                  FROM ai_generations
                 WHERE status = 'completed' AND result_cid IS NOT NULL`;

  // Group-level visibility: listed somewhere, admin-removed nowhere.
  const visible = `SELECT grp
                     FROM base
                    GROUP BY grp
                   HAVING bool_or(listed) AND NOT bool_or(delisted_by_admin)`;

  // The build that represents the site: its newest LISTED one. The AI
  // summary and the stable link are only written to listed rows, so
  // taking the newest row unconditionally would show a blank entry for a
  // site regenerated with the switch left off.
  const representative = `SELECT DISTINCT ON (b.grp) b.*
                            FROM base b
                            JOIN visible v ON v.grp = b.grp
                           WHERE b.listed = TRUE
                           ORDER BY b.grp, b.completed_at DESC NULLS LAST`;

  const cte = `WITH base AS (${base}),
                    visible AS (${visible}),
                    rep AS (${representative})`;

  // The category filter applies to the representative build — the one
  // whose category is actually displayed.
  const params: any[] = [];
  let categorySql = '';
  if (opts.category) {
    params.push(opts.category);
    categorySql = ` WHERE listing_category = $${params.length}`;
  }

  // `rep` holds exactly one row per visible group, so counting its rows
  // counts websites.
  const countResult = await query<{ count: string }>(
    `${cte} SELECT COUNT(*) AS count FROM rep${categorySql}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const offset = (opts.page - 1) * opts.limit;
  params.push(opts.limit, offset);
  const result = await query<DirectoryEntry>(
    `${cte}
     SELECT id,
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
       FROM rep${categorySql}
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
  // Group-level, matching `listDirectory`: the caller is asking whether
  // the thing this id represents is on the public page, and that is
  // decided by the whole website, not by one build's flags.
  const result = await query<{ ok: boolean }>(
    `SELECT bool_or(listed) AND NOT bool_or(delisted_by_admin) AS ok
       FROM ai_generations
      WHERE status = 'completed'
        AND COALESCE(listing_group, id::text) = (
              SELECT COALESCE(listing_group, id::text)
                FROM ai_generations WHERE id = $1
            )`,
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

/**
 * A website GROUP's directory state, owner-scoped.
 *
 * Why group-keyed and not id-keyed: `ai_generations.id` is the server's
 * jobId, which the CLIENT only holds while a generation is in flight —
 * it is thrown away once the job completes. The client's own generation
 * id is a different UUID entirely, so an id-keyed lookup 404s for every
 * finished site. The group (the website's tag id) is stable, is what the
 * client always has, and is already what the directory de-duplicates on.
 *
 * `listed` / `delistedByAdmin` are folded across every build of the site
 * (see the module comment) so the app's switch reports what the public
 * page actually shows. Reading only the newest build made the switch say
 * "off" for a site that was still listed through an earlier build.
 *
 * `id` is the newest build, and is where per-entry detail (name, link,
 * AI summary) is written.
 *
 * Returns null when the group has no completed build owned by this user
 * — the same answer for "not yours" as for "does not exist".
 */
export async function getGroupListingRow(
  group: string,
  userId: string
): Promise<{
  id: string;
  listed: boolean;
  delisted_by_admin: boolean;
  listing_url: string | null;
} | null> {
  const result = await query<{
    id: string | null;
    listed: boolean | null;
    delisted_by_admin: boolean | null;
    listing_url: string | null;
    n: string;
  }>(
    `SELECT (ARRAY_AGG(id ORDER BY completed_at DESC NULLS LAST))[1]          AS id,
            bool_or(listed)                                                   AS listed,
            bool_or(delisted_by_admin)                                        AS delisted_by_admin,
            (ARRAY_AGG(listing_url ORDER BY (listing_url IS NULL) ASC,
                                            completed_at DESC NULLS LAST))[1] AS listing_url,
            COUNT(*)                                                          AS n
       FROM ai_generations
      WHERE listing_group = $1
        AND (user_id = $2 OR user_email = $2)
        AND status = 'completed'`,
    [group, userId]
  );
  const row = result.rows[0];
  // An aggregate over no rows still returns one row, of NULLs.
  if (!row || parseInt(row.n ?? '0', 10) === 0 || !row.id) return null;
  return {
    id: row.id,
    listed: row.listed === true,
    delisted_by_admin: row.delisted_by_admin === true,
    listing_url: row.listing_url,
  };
}

/**
 * Turn a whole website's listing on or off, owner-scoped.
 *
 * Group-wide on purpose. Writing one row let an older build keep the
 * site in the directory after its owner switched listing off — a
 * withdrawal the user could not complete. Consent is per website, so the
 * write is too.
 *
 * Returns false when nothing matched (wrong owner, or unknown group).
 */
export async function setListedForGroup(
  group: string,
  userId: string,
  listed: boolean
): Promise<boolean> {
  const result = await query(
    `UPDATE ai_generations
        SET listed = $1, updated_at = CURRENT_TIMESTAMP
      WHERE listing_group = $2
        AND (user_id = $3 OR user_email = $3)
        AND status = 'completed'`,
    [listed, group, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Apply the display name and stable link to EVERY build of a website.
 *
 * The directory shows the newest listed build, and which build that is
 * changes as the site is regenerated. Writing these to one row only
 * would mean the entry's name and link depended on which build happened
 * to be representative. The IPNS front door is stable across
 * regenerations, so it is correct for all of them.
 *
 * `name` / `url` are skipped when undefined so a caller can set one
 * without clearing the other. The URL must already have passed
 * `isAllowedListingUrl`.
 */
export async function setListingDetailsForGroup(
  group: string,
  userId: string,
  details: { name?: string | null; url?: string }
): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  if (details.name !== undefined) {
    params.push(details.name);
    sets.push(`listing_name = $${params.length}`);
  }
  if (details.url !== undefined) {
    params.push(details.url);
    sets.push(`listing_url = $${params.length}`);
  }
  if (sets.length === 0) return;
  params.push(group, userId);
  await query(
    `UPDATE ai_generations
        SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE listing_group = $${params.length - 1}
        AND (user_id = $${params.length} OR user_email = $${params.length})
        AND status = 'completed'`,
    params
  );
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
