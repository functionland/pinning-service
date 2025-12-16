import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface Pin {
  request_id: string;
  cid: string;
  name: string;
  created_at: string;
  status: string;
  size: number;
}

interface PinsResponse {
  pins: Pin[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function Pins() {
  const { t } = useLanguage();
  const [data, setData] = useState<PinsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCid, setNewCid] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedValue, setExpandedValue] = useState<{ type: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshingPins, setRefreshingPins] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchPins();
  }, [page, searchQuery]);

  const fetchPins = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (searchQuery.trim()) {
        params.set('search', searchQuery.trim());
      }
      const res = await fetch(`/api/pins?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch pins');
      const result = await res.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchPins();
  };

  const clearSearch = () => {
    setSearchQuery('');
    setPage(1);
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const refreshPin = async (requestId: string) => {
    setRefreshingPins(prev => new Set(prev).add(requestId));
    try {
      const res = await fetch(`/api/pins/${requestId}/refresh`, {
        method: 'POST',
        credentials: 'include'
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to refresh pin');
      }
      // Refresh the pins list to get updated data
      await fetchPins();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh pin');
    } finally {
      setRefreshingPins(prev => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  const addPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCid.trim()) return;

    setAdding(true);
    setError(null);
    try {
      const res = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cid: newCid.trim(), name: newName.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add pin');
      }

      setNewCid('');
      setNewName('');
      setShowAddModal(false);
      setPage(1);
      await fetchPins();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setAdding(false);
    }
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleString();
  };

  const getStatusColor = (status: string): string => {
    switch (status.toLowerCase()) {
      case 'pinned':
        return 'bg-green-100 text-green-800';
      case 'queued':
        return 'bg-yellow-100 text-yellow-800';
      case 'pinning':
        return 'bg-blue-100 text-blue-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.pins.title}</h1>
          <p className="text-gray-600 mt-1">
            {data ? `${data.total} ${t.pins.totalPins}` : t.common.loading}
          </p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary">
          + {t.pins.addPin}
        </button>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.pins.searchPlaceholder}
            className="input w-full pl-10"
          />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        {searchQuery && (
          <button type="button" onClick={clearSearch} className="btn-secondary">
            {t.pins.clear}
          </button>
        )}
      </form>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {/* Expand modal */}
      {expandedValue && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setExpandedValue(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-xl font-semibold text-gray-900">{expandedValue.type}</h2>
              <button onClick={() => setExpandedValue(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-6">
              <div className="bg-gray-50 rounded-lg p-4 break-all font-mono text-sm">
                {expandedValue.value}
              </div>
              <button
                onClick={() => copyToClipboard(expandedValue.value)}
                className="mt-4 btn-secondary w-full"
              >
                {copied ? t.pins.copied : t.pins.copy}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add pin modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b border-gray-100">
              <h2 className="text-xl font-semibold text-gray-900">{t.pins.addTitle}</h2>
            </div>
            <form onSubmit={addPin} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t.pins.cidLabel} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newCid}
                  onChange={(e) => setNewCid(e.target.value)}
                  placeholder={t.pins.cidPlaceholder}
                  className="input"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t.pins.cidHelp}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t.pins.nameLabel}
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t.pins.namePlaceholder}
                  className="input"
                />
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn-secondary"
                >
                  {t.pins.cancel}
                </button>
                <button type="submit" disabled={adding || !newCid.trim()} className="btn-primary">
                  {adding ? t.pins.adding : t.pins.add}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pins table */}
      {loading && !data ? (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      ) : data && data.pins.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">📌</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{t.pins.noPins}</h3>
          <p className="text-gray-600 mb-4">{t.pins.noPinsDesc}</p>
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            {t.pins.addFirst}
          </button>
        </div>
      ) : data && (
        <>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.pins.cid}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden sm:table-cell">
                      {t.pins.name}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden md:table-cell">
                      {t.pins.createdAt}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.pins.status}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden lg:table-cell">
                      {t.pins.requestId}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.pins.actions || 'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.pins.map((pin: Pin) => (
                    <tr key={pin.request_id} className="hover:bg-gray-50">
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-1">
                          <code className="text-sm font-mono text-gray-700">
                            {pin.cid.slice(0, 12)}...{pin.cid.slice(-6)}
                          </code>
                          <button
                            onClick={() => setExpandedValue({ type: t.pins.cid, value: pin.cid })}
                            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                            title="Expand"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-600 hidden sm:table-cell">
                        {pin.name || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-600 hidden md:table-cell">
                        {formatDate(pin.created_at)}
                      </td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(pin.status)}`}>
                          {pin.status}
                        </span>
                      </td>
                      <td className="px-4 py-4 hidden lg:table-cell">
                        <div className="flex items-center gap-1">
                          <code className="text-sm text-gray-500 font-mono">
                            {pin.request_id.slice(0, 8)}...
                          </code>
                          <button
                            onClick={() => setExpandedValue({ type: t.pins.requestId, value: pin.request_id })}
                            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                            title="Expand"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <button
                          onClick={() => refreshPin(pin.request_id)}
                          disabled={refreshingPins.has(pin.request_id)}
                          className="p-2 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                          title={t.pins.refresh || 'Refresh status'}
                        >
                          <svg 
                            className={`w-4 h-4 ${refreshingPins.has(pin.request_id) ? 'animate-spin' : ''}`} 
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex justify-between items-center">
              <p className="text-sm text-gray-600">
                {t.pins.page} {data.page} {t.pins.of} {data.totalPages}
              </p>
              <div className="flex space-x-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="btn-secondary disabled:opacity-50"
                >
                  {t.pins.previous}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="btn-secondary disabled:opacity-50"
                >
                  {t.pins.next}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
