import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface Stats {
  totalPins: number;
  totalSize: number;
  lastLogin: string | null;
  memberSince: string | null;
}

interface CreditStatus {
  balanceFula: number;
  currentStorageBytes: number;
  freeTierBytes: number;
  canUpload: boolean;
  isSuspended: boolean;
  message: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleString();
}

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [creditStatus, setCreditStatus] = useState<CreditStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isWelcome = searchParams.get('welcome') === 'true';

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [statsRes, creditsRes] = await Promise.all([
        fetch('/api/stats', { credentials: 'include' }),
        fetch('/api/credits', { credentials: 'include' }),
      ]);
      if (!statsRes.ok) throw new Error('Failed to fetch stats');
      const statsData = await statsRes.json();
      setStats(statsData);

      if (creditsRes.ok) {
        const creditsData = await creditsRes.json();
        setCreditStatus(creditsData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Welcome banner for new users */}
      {isWelcome && (
        <div className="bg-primary-50 border border-primary-200 rounded-xl p-6">
          <div className="flex items-start space-x-4">
            <div className="text-3xl">🎉</div>
            <div>
              <h2 className="text-lg font-semibold text-primary-800">
                {t.dashboard.welcomeTitle}
              </h2>
              <p className="text-primary-700 mt-1">
                {t.dashboard.welcomeDesc.split('API Keys')[0]}
                <Link to="/keys" className="underline font-medium">{t.nav.apiKeys}</Link>
                {t.dashboard.welcomeDesc.split('API Keys')[1] || ''}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.dashboard.title}</h1>
        <p className="text-gray-600 mt-1">{t.dashboard.welcomeBack}, {user?.name || user?.email}</p>
      </div>

      {/* Stats grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-24 mb-3"></div>
              <div className="h-8 bg-gray-200 rounded w-32"></div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700">
          {error}
        </div>
      ) : stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">{t.dashboard.totalPins}</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{stats.totalPins}</p>
              </div>
              <div className="text-4xl opacity-20">📌</div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">{t.dashboard.storageUsed}</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{formatBytes(stats.totalSize)}</p>
              </div>
              <div className="text-4xl opacity-20">💾</div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">{t.dashboard.lastLogin}</p>
                <p className="text-lg font-semibold text-gray-900 mt-1">{formatDate(stats.lastLogin)}</p>
              </div>
              <div className="text-4xl opacity-20">🕐</div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">{t.dashboard.memberSince}</p>
                <p className="text-lg font-semibold text-gray-900 mt-1">
                  {stats.memberSince ? new Date(stats.memberSince).toLocaleDateString() : 'Today'}
                </p>
              </div>
              <div className="text-4xl opacity-20">⭐</div>
            </div>
          </div>
        </div>
      )}

      {/* Credit status card */}
      {creditStatus && (
        <div className={`card ${creditStatus.isSuspended ? 'bg-red-50 border-red-200' : creditStatus.canUpload ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="text-3xl">{creditStatus.isSuspended ? '⚠️' : creditStatus.canUpload ? '✅' : '💳'}</div>
              <div>
                <h3 className="font-semibold text-gray-900">
                  {creditStatus.isSuspended ? 'Account Suspended' : `Balance: ${creditStatus.balanceFula.toFixed(2)} FULA`}
                </h3>
                <p className="text-sm text-gray-600">{creditStatus.message}</p>
              </div>
            </div>
            <Link to="/billing" className="btn-primary text-sm">
              {creditStatus.isSuspended ? 'Add Credits' : 'Manage Billing'}
            </Link>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.dashboard.quickActions}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Link to="/pins" className="card hover:shadow-md transition-shadow group">
            <div className="flex items-center space-x-4">
              <div className="text-3xl group-hover:scale-110 transition-transform">📋</div>
              <div>
                <h3 className="font-semibold text-gray-900">{t.dashboard.viewPins}</h3>
                <p className="text-sm text-gray-500">{t.dashboard.viewPinsDesc}</p>
              </div>
            </div>
          </Link>

          <Link to="/keys" className="card hover:shadow-md transition-shadow group">
            <div className="flex items-center space-x-4">
              <div className="text-3xl group-hover:scale-110 transition-transform">🔑</div>
              <div>
                <h3 className="font-semibold text-gray-900">{t.dashboard.apiKeys}</h3>
                <p className="text-sm text-gray-500">{t.dashboard.apiKeysDesc}</p>
              </div>
            </div>
          </Link>

          <Link to="/referrals" className="card hover:shadow-md transition-shadow group">
            <div className="flex items-center space-x-4">
              <div className="text-3xl group-hover:scale-110 transition-transform">🎁</div>
              <div>
                <h3 className="font-semibold text-gray-900">{t.nav.referrals || 'Referrals'}</h3>
                <p className="text-sm text-gray-500">{t.referrals?.subtitle || 'Share & earn rewards'}</p>
              </div>
            </div>
          </Link>

          <Link to="/profile" className="card hover:shadow-md transition-shadow group">
            <div className="flex items-center space-x-4">
              <div className="text-3xl group-hover:scale-110 transition-transform">👤</div>
              <div>
                <h3 className="font-semibold text-gray-900">{t.dashboard.profile}</h3>
                <p className="text-sm text-gray-500">{t.dashboard.profileDesc}</p>
              </div>
            </div>
          </Link>
        </div>
      </div>

      {/* API documentation hint */}
      <div className="card bg-gray-50 border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">{t.dashboard.apiDocsTitle}</h2>
        <p className="text-gray-600 mb-4">
          {t.dashboard.apiDocsDesc}
        </p>
        <code className="block bg-white rounded-lg p-4 text-sm font-mono text-gray-700 overflow-x-auto">
          curl -X POST "https://api.cloud.fx.land/pins" \<br />
          &nbsp;&nbsp;-H "Authorization: Bearer YOUR_API_KEY" \<br />
          &nbsp;&nbsp;-H "Content-Type: application/json" \<br />
          &nbsp;&nbsp;-d '{`{"cid": "Qm..."}`}'
        </code>
      </div>
    </div>
  );
}
