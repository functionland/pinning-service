import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface ReferralInfo {
  code: string;
  createdAt: string;
  totalReferred: number;
  totalCreditsFromReferrals: number;
}

interface ReferredUser {
  email: string;
  joinedAt: string;
  totalCreditsPurchased: number;
}

interface ReferredResponse {
  items: ReferredUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function Referrals() {
  const { t } = useLanguage();
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [referred, setReferred] = useState<ReferredResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchReferralInfo();
  }, []);

  useEffect(() => {
    fetchReferredUsers();
  }, [page]);

  const fetchReferralInfo = async () => {
    try {
      const res = await fetch('/api/referral', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch referral info');
      const data = await res.json();
      setInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const fetchReferredUsers = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/referral/referred?page=${page}&limit=20`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch referred users');
      const data = await res.json();
      setReferred(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const referralLink = info ? `${window.location.origin}/login?ref=${info.code}&redirect=/download` : '';

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error}</p>
        <button onClick={() => window.location.reload()} className="mt-4 btn-primary">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.referrals?.title || 'Referrals'}</h1>
        <p className="text-gray-600 mt-1">{t.referrals?.subtitle || 'Share your referral link and track your referrals'}</p>
      </div>

      {/* Referral Code Card */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.referrals?.yourCode || 'Your Referral Code'}</h2>

        {info ? (
          <div className="space-y-4">
            {/* Code Display */}
            <div className="flex items-center gap-3">
              <div className="flex-1 bg-gray-100 rounded-lg px-4 py-3 font-mono text-lg font-semibold text-primary-600">
                {info.code}
              </div>
              <button
                onClick={() => copyToClipboard(info.code)}
                className="btn-secondary px-4 py-3"
              >
                {copied ? (t.referrals?.copied || 'Copied!') : (t.referrals?.copyCode || 'Copy')}
              </button>
            </div>

            {/* Share Link */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t.referrals?.shareLink || 'Share this link'}
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  readOnly
                  value={referralLink}
                  className="flex-1 input bg-gray-50"
                />
                <button
                  onClick={() => copyToClipboard(referralLink)}
                  className="btn-primary px-4 py-2"
                >
                  {t.referrals?.copyLink || 'Copy Link'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="animate-pulse h-24 bg-gray-100 rounded-lg"></div>
        )}
      </div>

      {/* Stats Card */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.referrals?.stats || 'Referral Stats'}</h2>

        {info ? (
          <div className="grid grid-cols-2 gap-6">
            <div className="text-center p-4 bg-primary-50 rounded-lg">
              <p className="text-3xl font-bold text-primary-600">{info.totalReferred}</p>
              <p className="text-sm text-gray-600 mt-1">{t.referrals?.totalReferred || 'Total Referred'}</p>
            </div>
            <div className="text-center p-4 bg-green-50 rounded-lg">
              <p className="text-3xl font-bold text-green-600">{info.totalCreditsFromReferrals.toFixed(2)}</p>
              <p className="text-sm text-gray-600 mt-1">{t.referrals?.totalCredits || 'FULA Credits from Referrals'}</p>
            </div>
          </div>
        ) : (
          <div className="animate-pulse grid grid-cols-2 gap-6">
            <div className="h-24 bg-gray-100 rounded-lg"></div>
            <div className="h-24 bg-gray-100 rounded-lg"></div>
          </div>
        )}
      </div>

      {/* Referred Users Table */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.referrals?.referredUsers || 'Referred Users'}</h2>

        {loading && !referred ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 bg-gray-100 rounded"></div>
            ))}
          </div>
        ) : referred && referred.items.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.referrals?.email || 'Email'}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.referrals?.joinedAt || 'Joined'}
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.referrals?.creditsPurchased || 'Credits Purchased'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {referred.items.map((user, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-sm text-gray-900">{user.email}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{formatDate(user.joinedAt)}</td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">
                        {user.totalCreditsPurchased.toFixed(2)} FULA
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {referred.totalPages > 1 && (
              <div className="flex justify-between items-center mt-4 pt-4 border-t border-gray-100">
                <p className="text-sm text-gray-600">
                  {t.pins?.page || 'Page'} {referred.page} {t.pins?.of || 'of'} {referred.totalPages}
                </p>
                <div className="flex space-x-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="btn-secondary disabled:opacity-50"
                  >
                    {t.pins?.previous || 'Previous'}
                  </button>
                  <button
                    onClick={() => setPage(p => Math.min(referred.totalPages, p + 1))}
                    disabled={page === referred.totalPages}
                    className="btn-secondary disabled:opacity-50"
                  >
                    {t.pins?.next || 'Next'}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-8">
            <div className="text-4xl mb-3">👥</div>
            <p className="text-gray-600">{t.referrals?.noReferrals || 'No referrals yet'}</p>
            <p className="text-sm text-gray-500 mt-1">
              {t.referrals?.noReferralsDesc || 'Share your referral link to start tracking referrals'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
