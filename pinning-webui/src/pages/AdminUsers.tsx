import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface SuspendedUser {
  userId: string;
  email: string;
  balanceFula: number;
  suspendedAt: string;
  storageBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default function AdminUsers() {
  const { t } = useLanguage();
  const [suspendedUsers, setSuspendedUsers] = useState<SuspendedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Credit adjustment form
  const [adjustEmail, setAdjustEmail] = useState('');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustSuccess, setAdjustSuccess] = useState<string | null>(null);

  // Unsuspend state
  const [unsuspending, setUnsuspending] = useState<string | null>(null);

  // Scan blocks form
  const [scanChainId, setScanChainId] = useState('8453');
  const [scanBlocks, setScanBlocks] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<Array<{ block: number; transfers: number; credited: number }> | null>(null);

  useEffect(() => {
    fetchSuspendedUsers();
  }, []);

  const fetchSuspendedUsers = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/suspended', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch suspended users');
      const data = await res.json();
      setSuspendedUsers(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleUnsuspend = async (userId: string) => {
    try {
      setUnsuspending(userId);
      const res = await fetch('/api/admin/unsuspend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId }),
      });

      if (!res.ok) throw new Error('Failed to unsuspend user');

      // Refresh the list
      await fetchSuspendedUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to unsuspend user');
    } finally {
      setUnsuspending(null);
    }
  };

  const handleAdjustCredits = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdjustError(null);
    setAdjustSuccess(null);

    if (!adjustEmail || !adjustAmount || !adjustReason) {
      setAdjustError('All fields are required');
      return;
    }

    const amount = parseFloat(adjustAmount);
    if (isNaN(amount)) {
      setAdjustError('Invalid amount');
      return;
    }

    try {
      setAdjusting(true);
      const res = await fetch('/api/admin/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: adjustEmail,
          amount,
          reason: adjustReason,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to adjust credits');
      }

      const data = await res.json();
      setAdjustSuccess(`Credits adjusted. New balance: ${data.newBalance.toFixed(2)} FULA`);
      setAdjustEmail('');
      setAdjustAmount('');
      setAdjustReason('');

      // Refresh suspended users list in case status changed
      await fetchSuspendedUsers();
    } catch (err) {
      setAdjustError(err instanceof Error ? err.message : 'Failed to adjust credits');
    } finally {
      setAdjusting(false);
    }
  };

  const handleScanBlocks = async (e: React.FormEvent) => {
    e.preventDefault();
    setScanError(null);
    setScanResults(null);

    const blocks = scanBlocks.split(/[\s,]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
    if (blocks.length === 0) {
      setScanError('Enter at least one valid block number');
      return;
    }

    try {
      setScanning(true);
      const res = await fetch('/api/admin/scan-blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ chainId: parseInt(scanChainId), blocks }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to scan blocks');
      }

      const data = await res.json();
      setScanResults(data.results);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Failed to scan blocks');
    } finally {
      setScanning(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      {/* Suspended Users Section */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t.admin?.suspendedUsers || 'Suspended Users'}
        </h2>

        {loading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 bg-gray-100 rounded"></div>
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-red-600">{error}</p>
            <button onClick={fetchSuspendedUsers} className="mt-4 btn-primary">
              Retry
            </button>
          </div>
        ) : suspendedUsers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.admin?.email || 'User'}
                  </th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.admin?.balance || 'Balance'}
                  </th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.admin?.storage || 'Storage'}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.admin?.suspendedAt || 'Suspended At'}
                  </th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.admin?.actions || 'Actions'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {suspendedUsers.map((user) => (
                  <tr key={user.userId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900 font-mono">{user.email || user.userId.slice(0, 16) + '...'}</td>
                    <td className="px-4 py-3 text-sm text-right text-red-600 font-medium">
                      {user.balanceFula.toFixed(2)} FULA
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600">
                      {formatBytes(user.storageBytes)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatDate(user.suspendedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleUnsuspend(user.userId)}
                        disabled={unsuspending === user.userId}
                        className="btn-secondary text-sm disabled:opacity-50"
                      >
                        {unsuspending === user.userId
                          ? (t.common?.loading || 'Loading...')
                          : (t.admin?.unsuspend || 'Unsuspend')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8">
            <div className="text-4xl mb-3">✅</div>
            <p className="text-gray-600">{t.admin?.noSuspendedUsers || 'No suspended users'}</p>
          </div>
        )}
      </div>

      {/* Credit Adjustment Section */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t.admin?.creditAdjustment || 'Manual Credit Adjustment'}
        </h2>

        <form onSubmit={handleAdjustCredits} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t.admin?.userEmail || 'User Email'}
            </label>
            <input
              type="email"
              value={adjustEmail}
              onChange={(e) => setAdjustEmail(e.target.value)}
              placeholder="user@example.com"
              className="input w-full"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t.admin?.amount || 'Amount (FULA)'}
            </label>
            <input
              type="number"
              step="0.01"
              value={adjustAmount}
              onChange={(e) => setAdjustAmount(e.target.value)}
              placeholder="10.00 (positive to add, negative to subtract)"
              className="input w-full"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              {t.admin?.amountHint || 'Use positive numbers to add credits, negative to subtract'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t.admin?.reason || 'Reason'}
            </label>
            <input
              type="text"
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              placeholder="Support compensation, manual refund, etc."
              className="input w-full"
              required
            />
          </div>

          {adjustError && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">
              {adjustError}
            </div>
          )}

          {adjustSuccess && (
            <div className="bg-green-50 text-green-600 px-4 py-3 rounded-lg text-sm">
              {adjustSuccess}
            </div>
          )}

          <button
            type="submit"
            disabled={adjusting}
            className="btn-primary w-full disabled:opacity-50"
          >
            {adjusting ? (t.common?.loading || 'Processing...') : (t.admin?.adjustCredits || 'Adjust Credits')}
          </button>
        </form>
      </div>

      {/* Scan Missed Blocks Section */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Scan Missed Blocks
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Scan specific blocks for missed FULA credit transactions. Enter block numbers separated by commas or newlines.
        </p>

        <form onSubmit={handleScanBlocks} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Chain</label>
            <select
              value={scanChainId}
              onChange={(e) => setScanChainId(e.target.value)}
              className="input w-full"
            >
              <option value="8453">Base (8453)</option>
              <option value="1">Ethereum (1)</option>
              <option value="2046399126">SKALE Europa</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Block Numbers</label>
            <textarea
              value={scanBlocks}
              onChange={(e) => setScanBlocks(e.target.value)}
              placeholder="40916619, 41029539, 43623679, 43705728"
              className="input w-full h-24 resize-y"
              required
            />
          </div>

          {scanError && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{scanError}</div>
          )}

          {scanResults && (
            <div className="bg-green-50 px-4 py-3 rounded-lg text-sm space-y-1">
              {scanResults.map((r) => (
                <div key={r.block} className={r.credited > 0 ? 'text-green-700' : 'text-gray-600'}>
                  Block {r.block}: {r.transfers} transfer(s) found, {r.credited} new credit(s)
                </div>
              ))}
            </div>
          )}

          <button type="submit" disabled={scanning} className="btn-primary w-full disabled:opacity-50">
            {scanning ? 'Scanning...' : 'Scan Blocks'}
          </button>
        </form>
      </div>
    </div>
  );
}
