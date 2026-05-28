import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';
import ReferralTree from '../components/ReferralTree';

interface Referrer {
  userId: string;
  code: string;
  codeCreatedAt: string;
  totalReferred: number;
  totalCreditsFromReferrals: number;
  totalBonus: number;
}

function fmtFula(n: number): string {
  if (!isFinite(n)) return '0';
  const s = n.toFixed(6);
  return s.replace(/\.?0+$/, '') || '0';
}

interface ReferrersResponse {
  items: Referrer[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function AdminReferrals() {
  const { t } = useLanguage();
  const [referrers, setReferrers] = useState<ReferrersResponse | null>(null);
  const [selectedReferrer, setSelectedReferrer] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [includeZero, setIncludeZero] = useState(false);

  useEffect(() => {
    fetchReferrers();
  }, [page, includeZero]);

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

  const handleExportCsv = () => {
    window.location.href = '/api/admin/referrals/export/csv';
  };

  const truncateHash = (hash: string): string => {
    if (hash.length <= 16) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
  };

  const handleSelectReferrer = (key: string) => {
    if (selectedReferrer === key) {
      setSelectedReferrer(null);
    } else {
      setSelectedReferrer(key);
    }
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
                      {t.adminReferrals?.bonusPaid || 'Bonus Paid'}
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.adminReferrals?.actions || 'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {referrers.items.map((referrer) => {
                    const rowKey = `${referrer.userId}:${referrer.code}`;
                    return (
                    <>
                      <tr
                        key={rowKey}
                        className={`hover:bg-gray-50 cursor-pointer ${
                          selectedReferrer === rowKey ? 'bg-primary-50' : ''
                        }`}
                        onClick={() => handleSelectReferrer(rowKey)}
                      >
                        <td className="px-4 py-3 text-sm text-gray-900 font-mono" title={referrer.userId}>
                          {truncateHash(referrer.userId)}
                        </td>
                        <td className="px-4 py-3 font-mono text-sm text-gray-600">{referrer.code}</td>
                        <td className="px-4 py-3 text-sm text-right font-medium text-primary-600">
                          {referrer.totalReferred}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">
                          {referrer.totalCreditsFromReferrals.toFixed(2)} FULA
                        </td>
                        <td className="px-4 py-3 text-sm text-right font-medium text-purple-600">
                          {fmtFula(referrer.totalBonus ?? 0)} FULA
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            className="text-primary-600 hover:text-primary-800 text-sm font-medium"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectReferrer(rowKey);
                            }}
                          >
                            {selectedReferrer === rowKey
                              ? (t.adminReferrals?.hideDetails || 'Hide')
                              : (t.adminReferrals?.viewDetails || 'View Details')}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Row - Referral Tree */}
                      {selectedReferrer === rowKey && (
                        <tr>
                          <td colSpan={6} className="px-4 py-4 bg-gray-50">
                            <div className="space-y-3">
                              <h3 className="font-medium text-gray-900">
                                {t.adminReferrals?.referredBy || 'Users referred by'} <span className="font-mono text-sm">{truncateHash(referrer.userId)}</span>
                                <span className="text-sm font-normal text-gray-500 ml-1">
                                  {t.adminReferrals?.viaCode || 'via code'} <code className="font-mono text-sm text-primary-600">{referrer.code}</code>
                                </span>
                                <span className="text-sm font-normal text-gray-500 ml-2">
                                  ({t.referrals?.expandHint || 'Click arrow to expand referral chain'})
                                </span>
                              </h3>
                              <ReferralTree
                                userId={referrer.userId}
                                level={1}
                                maxLevel={3}
                                isAdmin={true}
                                code={referrer.code}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                    );
                  })}
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
