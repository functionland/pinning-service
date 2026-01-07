import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import ReferralTree from '../components/ReferralTree';

interface LevelStats {
  count: number;
  credits: number;
}

interface ReferralInfo {
  code: string;
  createdAt: string;
  stats: {
    level1: LevelStats;
    level2: LevelStats;
    level3: LevelStats;
    total: LevelStats;
  };
}

export default function Referrals() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchReferralInfo();
  }, []);

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

  const maskEmail = (email: string): string => {
    const [local, domain] = email.split('@');
    if (!domain) return email;
    const maskedLocal = local.length <= 2 ? local : local.slice(0, 2) + '****' + local.slice(-1);
    return `${maskedLocal}@${domain}`;
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Level 1 - Direct */}
            <div className="text-center p-4 bg-blue-50 rounded-lg">
              <p className="text-2xl font-bold text-blue-600">{info.stats.level1.count}</p>
              <p className="text-xs text-gray-500">{t.referrals?.level1 || 'Level 1'}</p>
              <p className="text-sm font-medium text-blue-600 mt-1">{info.stats.level1.credits.toFixed(2)} FULA</p>
              <p className="text-xs text-gray-400">{t.referrals?.level1Desc || 'Direct'}</p>
            </div>

            {/* Level 2 */}
            <div className="text-center p-4 bg-purple-50 rounded-lg">
              <p className="text-2xl font-bold text-purple-600">{info.stats.level2.count}</p>
              <p className="text-xs text-gray-500">{t.referrals?.level2 || 'Level 2'}</p>
              <p className="text-sm font-medium text-purple-600 mt-1">{info.stats.level2.credits.toFixed(2)} FULA</p>
              <p className="text-xs text-gray-400">{t.referrals?.level2Desc || '2nd Gen'}</p>
            </div>

            {/* Level 3 */}
            <div className="text-center p-4 bg-orange-50 rounded-lg">
              <p className="text-2xl font-bold text-orange-600">{info.stats.level3.count}</p>
              <p className="text-xs text-gray-500">{t.referrals?.level3 || 'Level 3'}</p>
              <p className="text-sm font-medium text-orange-600 mt-1">{info.stats.level3.credits.toFixed(2)} FULA</p>
              <p className="text-xs text-gray-400">{t.referrals?.level3Desc || '3rd Gen'}</p>
            </div>

            {/* Total */}
            <div className="text-center p-4 bg-green-50 rounded-lg border-2 border-green-200">
              <p className="text-2xl font-bold text-green-600">{info.stats.total.count}</p>
              <p className="text-xs text-gray-500">{t.referrals?.totalNetwork || 'Total Network'}</p>
              <p className="text-sm font-medium text-green-600 mt-1">{info.stats.total.credits.toFixed(2)} FULA</p>
              <p className="text-xs text-gray-400">{t.referrals?.users || 'users'}</p>
            </div>
          </div>
        ) : (
          <div className="animate-pulse grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="h-24 bg-gray-100 rounded-lg"></div>
            <div className="h-24 bg-gray-100 rounded-lg"></div>
            <div className="h-24 bg-gray-100 rounded-lg"></div>
            <div className="h-24 bg-gray-100 rounded-lg"></div>
          </div>
        )}
      </div>

      {/* Referred Users Tree */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t.referrals?.referredUsers || 'Referred Users'}
          <span className="text-sm font-normal text-gray-500 ml-2">
            ({t.referrals?.expandHint || 'Click arrow to expand referral chain'})
          </span>
        </h2>

        {user?.email ? (
          <div className="overflow-x-auto">
            <ReferralTree
              email={user.email}
              level={1}
              maxLevel={3}
              isAdmin={false}
              maskEmail={maskEmail}
            />
          </div>
        ) : (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 bg-gray-100 rounded"></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
