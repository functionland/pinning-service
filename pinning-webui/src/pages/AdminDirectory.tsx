import { useState, useEffect, useCallback } from 'react';

/**
 * Moderation for the public directory (yellow pages).
 *
 * Two views: everything currently listed, and the abuse reports visitors
 * have filed. A report never removes anything by itself — that would hand
 * any visitor a takedown button — so this page is where a human acts on
 * them.
 *
 * Delisting removes the DIRECTORY ENTRY only. The site is
 * content-addressed on IPFS and stays reachable to anyone holding its
 * link; the copy below says so rather than implying a takedown power
 * this system does not have.
 */

interface Listing {
  id: string;
  listing_name: string | null;
  listing_category: string | null;
  listing_description: string | null;
  url: string | null;
  listed: boolean;
  delisted_by_admin: boolean;
  completed_at: string | null;
  open_reports: number;
}

interface Report {
  id: string;
  generation_id: string;
  reason: string;
  details: string | null;
  resolved: boolean;
  created_at: string;
  listing_name: string | null;
  url: string | null;
  delisted_by_admin: boolean;
}

type Tab = 'listings' | 'reports';

function formatDate(raw: string | null): string {
  if (!raw) return '—';
  const d = new Date(raw);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function AdminDirectory() {
  const [tab, setTab] = useState<Tab>('listings');
  const [listings, setListings] = useState<Listing[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [lRes, rRes] = await Promise.all([
        fetch('/api/admin/directory/listings', { credentials: 'include' }),
        fetch('/api/admin/directory/reports', { credentials: 'include' }),
      ]);
      if (!lRes.ok || !rRes.ok) throw new Error('Failed to load directory data');
      setListings((await lRes.json()).listings || []);
      setReports((await rRes.json()).reports || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setDelisted = async (id: string, restore: boolean) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/directory/${id}/delist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ restore }),
      });
      if (!res.ok) throw new Error('Update failed');
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  const openReports = reports.filter((r) => !r.resolved).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Public Directory
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Entries shown on <code>/yellowpage</code>. Removing one takes it
            off the directory only — the site stays reachable on IPFS to
            anyone who already has its link.
          </p>
        </div>
        <button
          onClick={load}
          className="shrink-0 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      <div className="flex gap-2 border-b">
        <button
          onClick={() => setTab('listings')}
          className={`px-3 py-2 text-sm font-medium ${
            tab === 'listings'
              ? 'border-b-2 border-primary-600 text-primary-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Listings ({listings.length})
        </button>
        <button
          onClick={() => setTab('reports')}
          className={`px-3 py-2 text-sm font-medium ${
            tab === 'reports'
              ? 'border-b-2 border-primary-600 text-primary-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Reports{openReports > 0 ? ` (${openReports} open)` : ''}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-600" />
        </div>
      ) : tab === 'listings' ? (
        listings.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing is listed yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Category</th>
                  <th className="pb-2">Link</th>
                  <th className="pb-2">Published</th>
                  <th className="pb-2">Reports</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {listings.map((l) => (
                  <tr key={l.id} className="text-gray-700">
                    <td className="py-2 font-medium">
                      {l.listing_name || '(untitled)'}
                      {l.listing_description && (
                        <p className="max-w-md text-xs font-normal text-gray-500">
                          {l.listing_description}
                        </p>
                      )}
                    </td>
                    <td className="py-2 text-gray-500">
                      {l.listing_category || '—'}
                    </td>
                    <td className="py-2 max-w-xs truncate">
                      {l.url ? (
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow ugc"
                          className="text-primary-600 hover:underline"
                          title={l.url}
                        >
                          {l.url}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 text-gray-500">
                      {formatDate(l.completed_at)}
                    </td>
                    <td className="py-2">
                      {l.open_reports > 0 ? (
                        <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">
                          {l.open_reports}
                        </span>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td className="py-2">
                      {l.delisted_by_admin ? (
                        <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                          removed
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
                          listed
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        disabled={busyId === l.id}
                        onClick={() => setDelisted(l.id, l.delisted_by_admin)}
                        className={`rounded-md px-3 py-1 text-xs font-medium disabled:opacity-40 ${
                          l.delisted_by_admin
                            ? 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                            : 'bg-red-600 text-white hover:bg-red-700'
                        }`}
                      >
                        {l.delisted_by_admin ? 'Restore' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : reports.length === 0 ? (
        <p className="text-sm text-gray-500">No reports.</p>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => (
            <div
              key={r.id}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">
                    {r.listing_name || '(untitled)'}{' '}
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                      {r.reason}
                    </span>
                    {r.delisted_by_admin && (
                      <span className="ml-2 rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                        already removed
                      </span>
                    )}
                  </p>
                  {r.details && (
                    <p className="mt-1 text-sm text-gray-600">{r.details}</p>
                  )}
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      className="mt-1 block truncate text-xs text-primary-600 hover:underline"
                    >
                      {r.url}
                    </a>
                  )}
                  <p className="mt-1 text-xs text-gray-400">
                    {formatDate(r.created_at)}
                  </p>
                </div>
                {!r.delisted_by_admin && (
                  <button
                    disabled={busyId === r.generation_id}
                    onClick={() => setDelisted(r.generation_id, false)}
                    className="shrink-0 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    Remove listing
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
