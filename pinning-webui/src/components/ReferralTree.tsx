import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface ReferredUser {
  userId: string;
  joinedAt: string;
  referredAt?: string;
  totalCreditsPurchased: number;
  appDownloaded: boolean;
  appDownloadedAt: string | null;
  referralCount: number;
}

interface ReferredResponse {
  items: ReferredUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ReferralTreeProps {
  userId: string;
  level?: number;
  maxLevel?: number;
  isAdmin?: boolean;
  highlightUserId?: string; // userId hash to highlight (from email search)
  code?: string; // Optional per-code filter — only applied at the top level
  ancestorIds?: string[]; // Track ancestors to prevent infinite loops
}

// Display a truncated userId hash: first 8 + ... + last 4
const truncateHash = (hash: string): string => {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
};

export default function ReferralTree({
  userId,
  level = 1,
  maxLevel = 3,
  isAdmin = false,
  highlightUserId,
  code,
  ancestorIds = [],
}: ReferralTreeProps) {
  const { t } = useLanguage();
  const [data, setData] = useState<ReferredResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Reset to page 1 when the code filter changes
  useEffect(() => {
    setPage(1);
  }, [code]);

  const fetchReferrals = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const base = isAdmin
        ? `/api/admin/referrals/chain/${encodeURIComponent(userId)}`
        : `/api/referral/chain/${encodeURIComponent(userId)}`;
      const codeQs = code ? `&code=${encodeURIComponent(code)}` : '';
      const endpoint = `${base}?page=${page}&limit=20${codeQs}`;

      const res = await fetch(endpoint, { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 403) {
          throw new Error('Access denied');
        }
        throw new Error('Failed to fetch referrals');
      }
      const result = await res.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [userId, page, isAdmin, code]);

  useEffect(() => {
    fetchReferrals();
  }, [fetchReferrals]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // Indentation based on level
  const indentClass = level === 1 ? '' : level === 2 ? 'pl-6' : 'pl-12';
  const bgClass = level === 1 ? '' : level === 2 ? 'bg-gray-50/50' : 'bg-gray-100/50';

  if (loading && !data) {
    return (
      <div className={`${indentClass} animate-pulse space-y-2 py-2`}>
        {[1, 2, 3].map(i => (
          <div key={i} className="h-10 bg-gray-200 rounded"></div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${indentClass} text-sm text-red-600 py-4`}>
        {error}
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <div className={`${indentClass} text-sm text-gray-500 py-4 text-center`}>
        {t.referrals?.noReferrals || 'No referrals'}
      </div>
    );
  }

  return (
    <div className={`${indentClass} ${bgClass}`}>
      <table className="w-full">
        <thead className={level === 1 ? 'bg-gray-50 border-b border-gray-100' : ''}>
          <tr className="text-xs text-gray-500">
            <th className="text-left px-3 py-2 w-8"></th>
            <th className="text-left px-3 py-2">{t.referrals?.userId || 'User ID'}</th>
            <th className="text-left px-3 py-2">{t.referrals?.joinedAt || 'Joined'}</th>
            <th className="text-center px-3 py-2">{t.referrals?.appDownloaded || 'App'}</th>
            <th className="text-right px-3 py-2">{t.referrals?.creditsPurchased || 'Credits'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.items.map((user, idx) => {
            return (
              <ReferralRow
                key={`${user.userId}-${idx}`}
                user={user}
                level={level}
                maxLevel={maxLevel}
                isAdmin={isAdmin}
                highlightUserId={highlightUserId}
                ancestorIds={ancestorIds}
                isExpanded={expandedIds.has(user.userId)}
                onToggle={() => toggleExpand(user.userId)}
                formatDate={formatDate}
                t={t}
              />
            );
          })}
        </tbody>
      </table>

      {/* Pagination */}
      {data.totalPages > 1 && (
        <div className="flex justify-between items-center mt-3 pt-3 border-t border-gray-100">
          <span className="text-xs text-gray-500">
            {t.pins?.page || 'Page'} {data.page} {t.pins?.of || 'of'} {data.totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="btn-secondary text-xs py-1 px-2 disabled:opacity-50"
            >
              {t.pins?.previous || 'Previous'}
            </button>
            <button
              onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
              disabled={page === data.totalPages || loading}
              className="btn-secondary text-xs py-1 px-2 disabled:opacity-50"
            >
              {t.pins?.next || 'Next'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ReferralRowProps {
  user: ReferredUser;
  level: number;
  maxLevel: number;
  isAdmin: boolean;
  highlightUserId?: string;
  ancestorIds: string[];
  isExpanded: boolean;
  onToggle: () => void;
  formatDate: (date: string) => string;
  t: ReturnType<typeof useLanguage>['t'];
}

function ReferralRow({
  user,
  level,
  maxLevel,
  isAdmin,
  highlightUserId,
  ancestorIds,
  isExpanded,
  onToggle,
  formatDate,
  t,
}: ReferralRowProps) {
  const isAncestor = ancestorIds.includes(user.userId);
  const canExpand = user.referralCount > 0 && level < maxLevel && !isAncestor;
  const isHighlighted = highlightUserId && user.userId === highlightUserId;

  return (
    <>
      <tr className={`hover:bg-gray-50/80 ${isHighlighted ? 'bg-yellow-50 ring-1 ring-yellow-200' : ''}`}>
        {/* Expand button */}
        <td className="px-3 py-2 w-8">
          {canExpand ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="p-1 rounded hover:bg-gray-200 transition-colors"
              title={`${user.referralCount} ${t.referrals?.totalReferred || 'referrals'}`}
            >
              <svg
                className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : isAncestor ? (
            <div className="flex justify-center" title="Circular reference detected">
              <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
          ) : (
            <span className="w-4 h-4 block"></span>
          )}
        </td>

        {/* User ID (truncated hash) */}
        <td className="px-3 py-2 text-sm text-gray-900">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs" title={user.userId}>{truncateHash(user.userId)}</span>
            {canExpand && (
              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                {user.referralCount}
              </span>
            )}
            {isAncestor && (
              <span className="text-[10px] text-red-500 bg-red-50 px-1 rounded border border-red-100 uppercase font-bold">
                Cycle
              </span>
            )}
          </div>
        </td>

        {/* Joined date */}
        <td className="px-3 py-2 text-sm text-gray-600">
          {formatDate(user.joinedAt)}
        </td>

        {/* App downloaded */}
        <td className="px-3 py-2 text-center">
          {user.appDownloaded ? (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800"
              title={user.appDownloadedAt ? formatDate(user.appDownloadedAt) : undefined}
            >
              {t.referrals?.downloaded || 'Yes'}
            </span>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </td>

        {/* Credits */}
        <td className="px-3 py-2 text-sm text-right font-medium text-gray-900">
          {user.totalCreditsPurchased.toFixed(2)} FULA
        </td>
      </tr>

      {/* Expanded nested referrals */}
      {isExpanded && canExpand && (
        <tr>
          <td colSpan={5} className="p-0">
            <div className="border-l-2 border-primary-200 ml-4">
              <ReferralTree
                userId={user.userId}
                level={level + 1}
                maxLevel={maxLevel}
                isAdmin={isAdmin}
                highlightUserId={highlightUserId}
                ancestorIds={[...ancestorIds, userId]}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
