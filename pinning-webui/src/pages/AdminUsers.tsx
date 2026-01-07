import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface SuspendedUser {
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

  const handleUnsuspend = async (email: string) => {
    try {
      setUnsuspending(email);
      const res = await fetch('/api/admin/unsuspend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
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
                    {t.admin?.email || 'Email'}
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
                  <tr key={user.email} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900">{user.email}</td>
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
                        onClick={() => handleUnsuspend(user.email)}
                        disabled={unsuspending === user.email}
                        className="btn-secondary text-sm disabled:opacity-50"
                      >
                        {unsuspending === user.email
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
    </div>
  );
}
