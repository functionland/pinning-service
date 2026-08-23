/**
 * Directory listing summary: a short blurb + a category, for the public
 * "yellow pages".
 *
 * INPUT CHOICE IS A PRIVACY DECISION — read before changing it.
 * ------------------------------------------------------------
 * The summary is derived from the GENERATED SITE'S OWN TEXT, never from
 * `ai_generations.prompt`.
 *
 * The prompt is the obvious-looking source and the wrong one. The client
 * composes it as `Website Name: ... / Category: ... / Styles: ...` PLUS
 * whatever the user typed freely, and users put personal detail in
 * prompts. Summarising that onto a public page is a data leak that no
 * encryption review would catch, because none of this is encrypted in
 * the first place. The generated site is already public by construction
 * — anyone with the CID can read it — so summarising it exposes nothing
 * that was not already published.
 *
 * COST
 * ----
 * One short, low-effort, schema-constrained call, and only for
 * generations the user actually listed. The result is stamped with
 * `listing_generated_at`, so toggling a listing off and on again never
 * pays for a second call.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import {
  getActiveCategories,
  needsListingSummary,
  saveListingSummary,
} from '../database/directory_postgres.js';
import { getGeneration } from '../database/postgres.js';

/** Hard cap on the blurb; the UI lays out one or two lines. */
export const LISTING_DESCRIPTION_MAX_CHARS = 140;

/** How much site text the model sees. A landing page's visible copy is
 *  far smaller than this; the cap exists so a pathological page cannot
 *  turn a cheap call into an expensive one. */
const MAX_SITE_TEXT_CHARS = 6000;

/** Fallback when the model returns a category we do not offer. */
export const FALLBACK_CATEGORY = 'other';

export interface ListingSummary {
  description: string;
  category: string;
}

const SUMMARY_SYSTEM_PROMPT = [
  'You write neutral, factual one-line directory entries for a public',
  'listing of websites.',
  '',
  'Rules:',
  `- description: at most ${LISTING_DESCRIPTION_MAX_CHARS} characters,`,
  '  plain text, no quotes, no emoji, no marketing superlatives. Say what',
  '  the site is FOR, in the third person. If the site has no discernible',
  '  purpose, describe what it visibly contains instead of inventing one.',
  '- category: choose EXACTLY ONE slug from the provided list. Never',
  '  invent a slug.',
  '- Never include personal names, email addresses, phone numbers, or',
  '  postal addresses in the description, even if they appear on the',
  '  page.',
].join('\n');

const SUMMARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    category: { type: 'string' },
  },
  required: ['description', 'category'],
  additionalProperties: false,
};

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: config.claudeApiKey });
  }
  return cachedClient;
}

/**
 * Visible text of an HTML page: no scripts, no styles, no tags.
 *
 * Deliberately a plain regex strip rather than a DOM parse — this only
 * feeds a summarizer, so approximate text is fine and a parser
 * dependency is not worth it.
 */
export function extractSiteText(html: string): string {
  const withoutCode = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Keep the <title> and meta description up front — on a one-page site
  // they are usually the most direct statement of what it is.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutCode)?.[1] ?? '';
  const metaDesc =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(
      withoutCode
    )?.[1] ?? '';

  const body = withoutCode
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const combined = [title.trim(), metaDesc.trim(), body]
    .filter((s) => s.length > 0)
    .join('\n')
    .trim();

  return combined.length > MAX_SITE_TEXT_CHARS
    ? combined.slice(0, MAX_SITE_TEXT_CHARS)
    : combined;
}

/** Clip to the column's contract; never mid-word if avoidable. */
export function clipDescription(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= LISTING_DESCRIPTION_MAX_CHARS) return flat;
  const cut = flat.slice(0, LISTING_DESCRIPTION_MAX_CHARS - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 40 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Coerce the model's category to one we actually offer.
 *
 * A model that invents a slug must not write an unfilterable value into
 * the directory, so anything unrecognised becomes [FALLBACK_CATEGORY].
 */
export function coerceCategory(raw: string, allowed: string[]): string {
  const slug = raw.trim().toLowerCase();
  if (allowed.includes(slug)) return slug;
  return allowed.includes(FALLBACK_CATEGORY) ? FALLBACK_CATEGORY : allowed[0];
}

export interface GenerateListingSummaryOptions {
  signal?: AbortSignal;
  /** Injectable seam for tests. */
  anthropicClient?: Anthropic;
}

export async function generateListingSummary(
  siteText: string,
  categories: Array<{ slug: string; label: string }>,
  opts: GenerateListingSummaryOptions = {}
): Promise<ListingSummary> {
  const client = opts.anthropicClient ?? getClient();
  const model = config.claudeSocialModel || config.claudeModel;
  const allowed = categories.map((c) => c.slug);

  const categoryList = categories
    .map((c) => `- ${c.slug}: ${c.label}`)
    .join('\n');

  const stream = client.messages.stream(
    {
      model,
      max_tokens: 1000,
      system: SUMMARY_SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SUMMARY_JSON_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            'Categories to choose from:',
            categoryList,
            '',
            'Website text:',
            siteText,
          ].join('\n'),
        },
      ],
    } as Anthropic.MessageStreamParams,
    { signal: opts.signal }
  );

  const response = await stream.finalMessage();
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no listing summary');
  }

  let parsed: { description?: string; category?: string };
  try {
    let jsonText = textBlock.text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    }
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Claude returned unparseable listing summary');
  }

  return {
    description: clipDescription(parsed.description ?? ''),
    category: coerceCategory(parsed.category ?? '', allowed),
  };
}

/** Fetch a published site's index for the lazy (toggle-on) path. */
async function fetchPublishedHtml(gatewayUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(gatewayUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`gateway ${res.status}`);
    }
    const text = await res.text();
    // Bound the read: a listing blurb never needs more than this, and an
    // unbounded read of an arbitrary published page is a footgun.
    return text.slice(0, 512 * 1024);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Produce and store the listing summary for [jobId], if it needs one.
 *
 * Two call sites, both idempotent:
 *   1. generation completion, which passes [html] because the service
 *      still holds the generated files — no fetch, no extra latency.
 *   2. the first time a user toggles listing ON for an already-finished
 *      site, which has no html and fetches the published page.
 *
 * Best-effort by design: a failure here must never fail a generation or
 * a toggle. The entry simply lists without a blurb until something
 * retries.
 */
export async function ensureListingSummary(
  jobId: string,
  opts: { html?: string; signal?: AbortSignal } = {}
): Promise<ListingSummary | null> {
  try {
    if (!(await needsListingSummary(jobId))) return null;

    // Re-read the row RIGHT NOW rather than trusting a `listed` value
    // the caller read earlier. A generation runs for up to 20 minutes
    // and the owner can toggle listing off from the website screen while
    // it runs; without this, a site the user just opted OUT of would
    // still be summarised and published.
    const job = await getGeneration(jobId);
    if (!job) return null;
    if (job.listed !== true || job.delisted_by_admin === true) {
      return null;
    }

    const categories = await getActiveCategories();
    if (categories.length === 0) {
      console.warn('[directory] No active categories; skipping summary');
      return null;
    }

    let html = opts.html;
    if (!html) {
      if (!job.gateway_url) {
        console.warn(`[directory] Job ${jobId} has no gateway_url yet`);
        return null;
      }
      html = await fetchPublishedHtml(job.gateway_url);
    }

    const siteText = extractSiteText(html);
    if (siteText.length < 20) {
      console.warn(`[directory] Job ${jobId}: too little text to summarise`);
      return null;
    }

    const summary = await generateListingSummary(siteText, categories, {
      signal: opts.signal,
    });
    await saveListingSummary(jobId, summary.description, summary.category);
    console.log(
      `[directory] Job ${jobId}: listed as "${summary.category}" — ${summary.description}`
    );
    return summary;
  } catch (error) {
    console.error(
      `[directory] Listing summary failed for ${jobId}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
