import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface Referrer {
  email: string;
  code: string;
  codeCreatedAt: string;
  totalReferred: number;
  totalCreditsFromReferrals: number;
}

interface ReferredUser {
  email: string;
  joinedAt: string;
  referredAt: string;
  totalCreditsPurchased: number;
}

interface ReferrersResponse {
  items: Referrer[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ReferredResponse {
  referrer: string;
  referrerCode: string | null;
  items: ReferredUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function AdminReferrals() {
  const { t } = useLanguage();
  const [referrers, setReferrers] = useState<ReferrersResponse | null>(null);
  const [selectedReferrer, setSelectedReferrer] = useState<string | null>(null);
  const [referredUsers, setReferredUsers] = useState<ReferredResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingReferred, setLoadingReferred] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [referredPage, setReferredPage] = useState(1);
  const [includeZero, setIncludeZero] = useState(false);

  useEffect(() => {
    fetchReferrers();
  }, [page, includeZero]);

  useEffect(() => {
    if (selectedReferrer) {
      fetchReferredUsers(selectedReferrer);
    }
  }, [selectedReferrer, referredPage]);

  const fetchReferrers = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `/api/admin/referrals?page=${page}&limit=20&includeZero=${includeZero}`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error('Failed to fetch referrers');
      const data = await res.json();
      setReferrers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const fetchReferredUsers = async (email: string) => {
    try {
      setLoadingReferred(true);
      const res = await fetch(
        `/api/admin/referrals/${encodeURIComponent(email)}?page=${referredPage}&limit=20`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error('Failed to fetch referred users');
      const data = await res.json();
      setReferredUsers(data);
    } catch (err) {
      console.error('Failed to fetch referred users:', err);
    } finally {
      setLoadingReferred(false);
    }
  };

  const handleExportCsv = () => {
    window.location.href = '/api/admin/referrals/export/csv';
  };

  const handleSelectReferrer = (email: string) => {
    if (selectedReferrer === email) {
      setSelectedReferrer(null);
      setReferredUsers(null);
    } else {
      setSelectedReferrer(email);
      setReferredPage(1);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeZero}
              onChange={(e) => {
                setIncludeZero(e.target.checked);
                setPage(1);
              }}
              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            {t.adminReferrals?.includeZero || 'Include users with 0 referrals'}
          </label>
        </div>

        <button onClick={handleExportCsv} className="btn-primary flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {t.adminReferrals?.exportCsv || 'Export CSV'}
        </button>
      </div>

      {/* Referrers Table */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t.adminReferrals?.referrers || 'Referrers'}
          {referrers && <span className="text-sm font-normal text-gray-500 ml-2">({referrers.total} total)</span>}
        </h2>

        {loading && !referrers ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-12 bg-gray-100 rounded"></div>
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-red-600">{error}</p>
            <button onClick={fetchReferrers} className="mt-4 btn-primary">
              Retry
            </button>
          </div>
        ) : referrers && referrers.items.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.adminReferrals?.referrer || 'Referrer'}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.adminReferrals?.code || 'Code'}
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.adminReferrals?.totalReferred || 'Referred'}
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.adminReferrals?.totalCredits || 'Credits Generated'}
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.adminReferrals?.actions || 'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {referrers.items.map((referrer) => (
                    <>
                      <tr
                        key={referrer.email}
                        className={`hover:bg-gray-50 cursor-pointer ${
                          selectedReferrer === referrer.email ? 'bg-primary-50' : ''
                        }`}
                        onClick={() => handleSelectReferrer(referrer.email)}
                      >
                        <td className="px-4 py-3 text-sm text-gray-900">{referrer.email}</td>
                        <td className="px-4 py-3 font-mono text-sm text-gray-600">{referrer.code}</td>
                        <td className="px-4 py-3 text-sm text-right font-medium text-primary-600">
                          {referrer.totalReferred}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">
                          {referrer.totalCreditsFromReferrals.toFixed(2)} FULA
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            className="text-primary-600 hover:text-primary-800 text-sm font-medium"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectReferrer(referrer.email);
                            }}
                          >
                            {selectedReferrer === referrer.email
                              ? (t.adminReferrals?.hideDetails || 'Hide')
                              : (t.adminReferrals?.viewDetails || 'View Details')}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Row - Referred Users */}
                      {selectedReferrer === referrer.email && (
                        <tr>
                          <td colSpan={5} className="px-4 py-4 bg-gray-50">
                            {loadingReferred ? (
                              <div className="animate-pulse space-y-2">
                                {[1, 2, 3].map(i => (
                                  <div key={i} className="h-8 bg-gray-200 rounded"></div>
                                ))}
                              </div>
                            ) : referredUsers && referredUsers.items.length > 0 ? (
                              <div className="space-y-3">
                                <h3 className="font-medium text-gray-900">
                                  {t.adminReferrals?.referredBy || 'Users referred by'} {referrer.email}
                                </h3>
                                <table className="w-full">
                                  <thead>
                                    <tr className="text-xs text-gray-500">
                                      <th className="text-left px-2 py-1">{t.adminReferrals?.email || 'Email'}</th>
                                      <th className="text-left px-2 py-1">{t.adminReferrals?.joinedAt || 'Joined'}</th>
                                      <th className="text-left px-2 py-1">{t.adminReferrals?.referredAt || 'Referred'}</th>
                                      <th className="text-right px-2 py-1">{t.adminReferrals?.credits || 'Credits'}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {referredUsers.items.map((user, idx) => (
                                      <tr key={idx} className="text-sm">
                                        <td className="px-2 py-1 text-gray-900">{user.email}</td>
                                        <td className="px-2 py-1 text-gray-600">{formatDate(user.joinedAt)}</td>
                                        <td className="px-2 py-1 text-gray-600">{formatDate(user.referredAt)}</td>
                                        <td className="px-2 py-1 text-right text-gray-900">
                                          {user.totalCreditsPurchased.toFixed(2)} FULA
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>

                                {/* Referred Users Pagination */}
                                {referredUsers.totalPages > 1 && (
                                  <div className="flex justify-between items-center pt-2">
                                    <span className="text-xs text-gray-500">
                                      Page {referredUsers.page} of {referredUsers.totalPages}
                                    </span>
                                    <div className="flex gap-2">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setReferredPage(p => Math.max(1, p - 1));
                                        }}
                                        disabled={referredPage === 1}
                                        className="btn-secondary text-xs py-1 px-2 disabled:opacity-50"
                                      >
                                        Previous
                                      </button>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setReferredPage(p => Math.min(referredUsers.totalPages, p + 1));
                                        }}
                                        disabled={referredPage === referredUsers.totalPages}
                                        className="btn-secondary text-xs py-1 px-2 disabled:opacity-50"
                                      >
                                        Next
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-sm text-gray-500 text-center py-4">
                                {t.adminReferrals?.noReferred || 'No referred users'}
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Main Pagination */}
            {referrers.totalPages > 1 && (
              <div className="flex justify-between items-center mt-4 pt-4 border-t border-gray-100">
                <p className="text-sm text-gray-600">
                  {t.pins?.page || 'Page'} {referrers.page} {t.pins?.of || 'of'} {referrers.totalPages}
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
                    onClick={() => setPage(p => Math.min(referrers.totalPages, p + 1))}
                    disabled={page === referrers.totalPages}
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
            <p className="text-gray-600">{t.adminReferrals?.noReferrers || 'No referrers found'}</p>
            {!includeZero && (
              <p className="text-sm text-gray-500 mt-1">
                {t.adminReferrals?.tryIncludeZero || 'Try enabling "Include users with 0 referrals"'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
