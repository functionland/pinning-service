import { useState, useEffect, useCallback } from 'react';

/**
 * Public directory ("yellow pages") of AI-generated websites.
 *
 * Unauthenticated, like /stats — and like Stats.tsx this calls a
 * DIFFERENT origin, so the URL is absolute and no credentials are sent
 * (the AI service replies with `Access-Control-Allow-Origin: *`).
 *
 * Only sites whose owner explicitly opted in are listed, and an admin can
 * delist one. Delisting removes the ENTRY only — the site itself is
 * content-addressed on IPFS and stays reachable to anyone holding its
 * link, which the disclaimer below states plainly rather than implying a
 * takedown power this system does not have.
 */

const DIRECTORY_BASE = 'https://ai.cloud.fx.land/api/v1/directory';

interface DirectoryEntry {
  id: string;
  name: string | null;
  description: string | null;
  category: string | null;
  url: string | null;
  cid: string | null;
  publishedAt: string | null;
}

interface Category {
  slug: string;
  label: string;
}

const REPORT_REASONS = [
  { value: 'spam', label: 'Spam' },
  { value: 'scam', label: 'Scam or fraud' },
  { value: 'malware', label: 'Malware or phishing' },
  { value: 'adult', label: 'Adult content' },
  { value: 'illegal', label: 'Illegal content' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'other', label: 'Something else' },
] as const;

const PAGE_SIZE = 24;

function formatDate(raw: string | null): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function Disclaimer() {
  return (
    <div
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
      role="note"
    >
      <p className="font-semibold">
        Third-party sites — no affiliation, no endorsement, no verification.
      </p>
      <p className="mt-2">
        Every website listed here was created by an independent user of
        FxFiles. These sites are <strong>not affiliated with, endorsed by,
        verified by, or guaranteed by</strong> FxFiles, Functionland, Fula,
        or any related entity. Listings are published by their owners and
        are not reviewed before they appear; they are provided
        &ldquo;as is&rdquo;, without warranty of any kind.
      </p>
      <p className="mt-2">
        Listings are community-reported and human-reviewed. Descriptions
        and categories are <strong>generated automatically</strong> and may
        be inaccurate or incomplete &mdash; use <em>Report</em> below a
        listing to flag an error or a problem, and it will be reviewed.
      </p>
      <p className="mt-2">
        <strong>All responsibility for a site&rsquo;s content, claims,
        products, and conduct rests solely with its publisher.</strong> We do
        not review listings before they appear and make no representation
        about their accuracy, legality, safety, or suitability.
      </p>
      <p className="mt-2">
        Verify independently before you interact with any listed site, share
        personal information, send funds, download files, or enter
        credentials. You use these links entirely at your own risk.
      </p>
      <p className="mt-2 text-xs">
        Use <em>Report</em> on a listing to flag it. Removing a listing
        removes it from this directory only — the site itself is stored on
        IPFS and remains reachable to anyone who already has its link.
      </p>
    </div>
  );
}

function ReportDialog({
  entry,
  onClose,
}: {
  entry: DirectoryEntry;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<string>('spam');
  const [details, setDetails] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>(
    'idle'
  );
  const [error, setError] = useState('');

  const submit = async () => {
    setState('sending');
    setError('');
    try {
      const res = await fetch(`${DIRECTORY_BASE}/${entry.id}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, details: details || undefined }),
      });
      if (!res.ok) {
        setError(
          res.status === 429
            ? 'Too many reports from this connection today.'
            : 'Could not submit the report.'
        );
        setState('error');
        return;
      }
      setState('done');
    } catch {
      setError('Could not reach the server.');
      setState('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900">Report listing</h3>
        <p className="mt-1 truncate text-sm text-gray-500">
          {entry.name || entry.cid}
        </p>

        {state === 'done' ? (
          <>
            <p className="mt-4 text-sm text-gray-700">
              Thanks — this listing has been queued for review. Reports do not
              remove a listing automatically.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                onClick={onClose}
                className="rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="mt-4 block text-sm font-medium text-gray-700">
              Reason
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {REPORT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>

            <label className="mt-4 block text-sm font-medium text-gray-700">
              Details <span className="text-gray-400">(optional)</span>
            </label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              maxLength={1000}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="What is wrong with this listing?"
            />

            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={state === 'sending'}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {state === 'sending' ? 'Sending…' : 'Submit report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function YellowPage() {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string>('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reporting, setReporting] = useState<DirectoryEntry | null>(null);

  useEffect(() => {
    fetch(`${DIRECTORY_BASE}/categories`)
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => setCategories([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (category) params.set('category', category);
      const res = await fetch(`${DIRECTORY_BASE}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(data.entries ?? []);
      setTotalPages(data.totalPages ?? 1);
      setTotal(data.total ?? 0);
    } catch {
      setError('Could not load the directory. Please try again.');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [page, category]);

  useEffect(() => {
    load();
  }, [load]);

  const labelFor = (slug: string | null) =>
    categories.find((c) => c.slug === slug)?.label ?? slug ?? '';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Yellow Pages</h1>
          <p className="mt-1 text-gray-600">
            A directory of websites created with FxFiles by their owners.
          </p>
        </header>

        {/* Above the fold, before any listing is shown. */}
        <div className="mb-6">
          <Disclaimer />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              setCategory('');
              setPage(1);
            }}
            className={`rounded-full px-3 py-1 text-sm ${
              category === ''
                ? 'bg-primary-600 text-white'
                : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-100'
            }`}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c.slug}
              onClick={() => {
                setCategory(c.slug);
                setPage(1);
              }}
              className={`rounded-full px-3 py-1 text-sm ${
                category === c.slug
                  ? 'bg-primary-600 text-white'
                  : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-100'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary-600" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-gray-500">
            No listings yet
            {category ? ' in this category' : ''}.
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-500">
              {total} {total === 1 ? 'site' : 'sites'}
            </p>
            <ul className="grid gap-4 sm:grid-cols-2">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col rounded-lg border border-gray-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold text-gray-900">
                      {e.name || 'Untitled site'}
                    </h2>
                    {e.category && (
                      <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {labelFor(e.category)}
                      </span>
                    )}
                  </div>

                  {e.description && (
                    <p className="mt-2 text-sm text-gray-600">
                      {e.description}
                    </p>
                  )}

                  <div className="mt-3 flex items-center justify-between">
                    {e.url ? (
                      <a
                        href={e.url}
                        target="_blank"
                        // noopener/noreferrer + ugc: these are untrusted
                        // third-party pages.
                        rel="noopener noreferrer nofollow ugc"
                        className="text-sm font-medium text-primary-600 hover:underline"
                      >
                        Visit site →
                      </a>
                    ) : (
                      <span className="text-sm text-gray-400">
                        No link available
                      </span>
                    )}
                    <span className="text-xs text-gray-400">
                      {formatDate(e.publishedAt)}
                    </span>
                  </div>

                  <button
                    onClick={() => setReporting(e)}
                    className="mt-3 self-start text-xs text-gray-400 hover:text-red-600"
                  >
                    Report
                  </button>
                </li>
              ))}
            </ul>

            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-600">
                  Page {page} of {totalPages}
                </span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {reporting && (
        <ReportDialog entry={reporting} onClose={() => setReporting(null)} />
      )}
    </div>
  );
}
