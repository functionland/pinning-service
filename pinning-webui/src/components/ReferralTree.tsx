import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface ReferredUser {
  email: string;
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
  email: string;
  level?: number;
  maxLevel?: number;
  isAdmin?: boolean;
  maskEmail?: (email: string) => string;
}

const defaultMaskEmail = (email: string): string => {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const maskedLocal = local.length <= 2 ? local : local.slice(0, 2) + '****' + local.slice(-1);
  return `${maskedLocal}@${domain}`;
};

export default function ReferralTree({
  email,
  level = 1,
  maxLevel = 3,
  isAdmin = false,
  maskEmail = defaultMaskEmail,
}: ReferralTreeProps) {
  const { t } = useLanguage();
  const [data, setData] = useState<ReferredResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedEmails, setExpandedEmails] = useState<Set<string>>(new Set());

  const fetchReferrals = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const endpoint = isAdmin
        ? `/api/admin/referrals/chain/${encodeURIComponent(email)}?page=${page}&limit=20`
        : `/api/referral/chain/${encodeURIComponent(email)}?page=${page}&limit=20`;

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
  }, [email, page, isAdmin]);

  useEffect(() => {
    fetchReferrals();
  }, [fetchReferrals]);

  const toggleExpand = (userEmail: string) => {
    setExpandedEmails(prev => {
      const next = new Set(prev);
      if (next.has(userEmail)) {
        next.delete(userEmail);
      } else {
        next.add(userEmail);
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

  const displayEmail = (email: string) => {
    return isAdmin ? email : maskEmail(email);
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
            <th className="text-left px-3 py-2">{t.referrals?.email || 'Email'}</th>
            <th className="text-left px-3 py-2">{t.referrals?.joinedAt || 'Joined'}</th>
            <th className="text-center px-3 py-2">{t.referrals?.appDownloaded || 'App'}</th>
            <th className="text-right px-3 py-2">{t.referrals?.creditsPurchased || 'Credits'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.items.map((user, idx) => (
            <ReferralRow
              key={`${user.email}-${idx}`}
              user={user}
              level={level}
              maxLevel={maxLevel}
              isAdmin={isAdmin}
              maskEmail={maskEmail}
              isExpanded={expandedEmails.has(user.email)}
              onToggle={() => toggleExpand(user.email)}
              displayEmail={displayEmail}
              formatDate={formatDate}
              t={t}
            />
          ))}
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
  maskEmail: (email: string) => string;
  isExpanded: boolean;
  onToggle: () => void;
  displayEmail: (email: string) => string;
  formatDate: (date: string) => string;
  t: ReturnType<typeof useLanguage>['t'];
}

function ReferralRow({
  user,
  level,
  maxLevel,
  isAdmin,
  maskEmail,
  isExpanded,
  onToggle,
  displayEmail,
  formatDate,
  t,
}: ReferralRowProps) {
  const canExpand = user.referralCount > 0 && level < maxLevel;

  return (
    <>
      <tr className="hover:bg-gray-50/80">
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
          ) : (
            <span className="w-4 h-4 block"></span>
          )}
        </td>

        {/* Email */}
        <td className="px-3 py-2 text-sm text-gray-900">
          <div className="flex items-center gap-2">
            <span className="font-mono">{displayEmail(user.email)}</span>
            {canExpand && (
              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                {user.referralCount}
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
                email={user.email}
                level={level + 1}
                maxLevel={maxLevel}
                isAdmin={isAdmin}
                maskEmail={maskEmail}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
