import { useState, useEffect } from 'react';

interface BlockedCidEntry {
  id: number;
  cid: string;
  reason: string | null;
  blocked_by: string | null;
  created_at: string;
}

export default function AdminBlockedCids() {
  const [entries, setEntries] = useState<BlockedCidEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newCid, setNewCid] = useState('');
  const [newReason, setNewReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [removing, setRemoving] = useState<string | null>(null);

  const fetchEntries = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/blocked-cids?limit=200', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch blocked CIDs');
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
      const res = await fetch('/api/admin/blocked-cids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cid: newCid.trim(), reason: newReason.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add');
      setNewCid('');
      setNewReason('');
      await fetchEntries();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (cid: string) => {
    if (!confirm(`Unblock CID ${cid}?`)) return;
    try {
      setRemoving(cid);
      const res = await fetch(`/api/admin/blocked-cids/${encodeURIComponent(cid)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to unblock');
      }
      await fetchEntries();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to unblock');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Add form */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Block a CID</h2>
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
          {addError && <p className="text-red-600 text-sm">{addError}</p>}
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            {adding ? 'Blocking...' : 'Block CID'}
          </button>
        </form>
      </div>

      {/* List */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Blocked CIDs ({entries.length})</h2>
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
          <p className="p-6 text-gray-500">No CIDs are currently blocked.</p>
        )}
        {!loading && entries.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left">CID</th>
                <th className="px-4 py-2 text-left">Reason</th>
                <th className="px-4 py-2 text-left">Blocked At</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="px-4 py-2 font-mono break-all max-w-md">{e.cid}</td>
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
                      {removing === e.cid ? 'Unblocking...' : 'Unblock'}
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
