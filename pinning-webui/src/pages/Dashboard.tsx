import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface Stats {
  totalPins: number;
  totalSize: number;
  lastLogin: string | null;
  memberSince: string | null;
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
  const [searchParams] = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isWelcome = searchParams.get('welcome') === 'true';

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch stats');
      const data = await res.json();
      setStats(data);
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
                Welcome to FULA Pinning Service!
              </h2>
              <p className="text-primary-700 mt-1">
                Your account has been created and an API key has been generated for you.
                Check the <Link to="/keys" className="underline font-medium">API Keys</Link> page to get started.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-1">Welcome back, {user?.name || user?.email}</p>
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
                <p className="text-sm font-medium text-gray-500">Total Pins</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{stats.totalPins}</p>
              </div>
              <div className="text-4xl opacity-20">📌</div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Storage Used</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{formatBytes(stats.totalSize)}</p>
              </div>
              <div className="text-4xl opacity-20">💾</div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Last Login</p>
                <p className="text-lg font-semibold text-gray-900 mt-1">{formatDate(stats.lastLogin)}</p>
              </div>
              <div className="text-4xl opacity-20">🕐</div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Member Since</p>
                <p className="text-lg font-semibold text-gray-900 mt-1">
                  {stats.memberSince ? new Date(stats.memberSince).toLocaleDateString() : 'Today'}
                </p>
              </div>
              <div className="text-4xl opacity-20">⭐</div>
            </div>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link to="/pins" className="card hover:shadow-md transition-shadow group">
            <div className="flex items-center space-x-4">
              <div className="text-3xl group-hover:scale-110 transition-transform">📋</div>
              <div>
                <h3 className="font-semibold text-gray-900">View Pins</h3>
                <p className="text-sm text-gray-500">Manage your pinned content</p>
              </div>
            </div>
          </Link>

          <Link to="/keys" className="card hover:shadow-md transition-shadow group">
            <div className="flex items-center space-x-4">
              <div className="text-3xl group-hover:scale-110 transition-transform">🔑</div>
              <div>
                <h3 className="font-semibold text-gray-900">API Keys</h3>
                <p className="text-sm text-gray-500">Manage your access tokens</p>
              </div>
            </div>
          </Link>

          <Link to="/profile" className="card hover:shadow-md transition-shadow group">
            <div className="flex items-center space-x-4">
              <div className="text-3xl group-hover:scale-110 transition-transform">👤</div>
              <div>
                <h3 className="font-semibold text-gray-900">Profile</h3>
                <p className="text-sm text-gray-500">Account settings</p>
              </div>
            </div>
          </Link>
        </div>
      </div>

      {/* API documentation hint */}
      <div className="card bg-gray-50 border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">API Documentation</h2>
        <p className="text-gray-600 mb-4">
          Use your API key to interact with the IPFS Pinning Service API. 
          The API follows the standard IPFS Pinning Service specification.
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
