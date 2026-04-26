import { useState, useEffect } from 'react';

type CidMode = 'block' | 'redirect';

interface CidPolicyEntry {
  id: number;
  cid: string;
  reason: string | null;
  blocked_by: string | null;
  created_at: string;
  mode: CidMode;
}

export default function AdminCidPolicies() {
  const [entries, setEntries] = useState<CidPolicyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newCid, setNewCid] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newMode, setNewMode] = useState<CidMode>('block');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [removing, setRemoving] = useState<string | null>(null);

  const fetchEntries = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/cid-policies?limit=200', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch CID policies');
      const data = await res.json();
      setEntries(data.items || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEntries();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    if (!newCid.trim()) {
      setAddError('CID is required');
      return;
    }
    try {
      setAdding(true);
      const res = await fetch('/api/admin/cid-policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          cid: newCid.trim(),
          reason: newReason.trim() || null,
          mode: newMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add');
      setNewCid('');
      setNewReason('');
      setNewMode('block');
      await fetchEntries();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (cid: string) => {
    if (!confirm(`Remove policy for CID ${cid}?`)) return;
    try {
      setRemoving(cid);
      const res = await fetch(`/api/admin/cid-policies/${encodeURIComponent(cid)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove');
      }
      await fetchEntries();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to remove');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Add form */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Add CID Policy</h2>
        <form onSubmit={handleAdd} className="space-y-3">
          <input
            type="text"
            value={newCid}
            onChange={(e) => setNewCid(e.target.value)}
            placeholder="CID (e.g. bafy... or Qm...)"
            className="w-full px-3 py-2 border border-gray-300 rounded font-mono text-sm"
          />
          <input
            type="text"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            placeholder="Reason (optional)"
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
          />
          <div className="flex items-center gap-6 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="cid-mode"
                value="block"
                checked={newMode === 'block'}
                onChange={() => setNewMode('block')}
              />
              <span>Block (HTTP 451)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="cid-mode"
                value="redirect"
                checked={newMode === 'redirect'}
                onChange={() => setNewMode('redirect')}
              />
              <span>Redirect to dweb.link (HTTP 301)</span>
            </label>
          </div>
          {addError && <p className="text-red-600 text-sm">{addError}</p>}
          <button
            type="submit"
            disabled={adding}
            className={`px-4 py-2 text-white rounded disabled:opacity-50 ${
              newMode === 'redirect'
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {adding
              ? 'Saving...'
              : newMode === 'redirect'
              ? 'Add Redirect'
              : 'Block CID'}
          </button>
        </form>
      </div>

      {/* List */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">CID Policies ({entries.length})</h2>
          <button
            onClick={fetchEntries}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            Refresh
          </button>
        </div>
        {loading && <p className="p-6 text-gray-500">Loading...</p>}
        {error && <p className="p-6 text-red-600">{error}</p>}
        {!loading && !error && entries.length === 0 && (
          <p className="p-6 text-gray-500">No CID policies are currently configured.</p>
        )}
        {!loading && entries.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left">CID</th>
                <th className="px-4 py-2 text-left">Mode</th>
                <th className="px-4 py-2 text-left">Reason</th>
                <th className="px-4 py-2 text-left">Added At</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="px-4 py-2 font-mono break-all max-w-md">{e.cid}</td>
                  <td className="px-4 py-2">
                    {e.mode === 'redirect' ? (
                      <span className="inline-block px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-700 whitespace-nowrap">
                        Redirect → dweb.link
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 text-xs rounded bg-red-100 text-red-700">
                        Block
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {e.reason || <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {new Date(e.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => handleRemove(e.cid)}
                      disabled={removing === e.cid}
                      className="text-blue-600 hover:text-blue-800 disabled:opacity-50"
                    >
                      {removing === e.cid ? 'Removing...' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
