import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface ApiKey {
  key_id: string;
  created_at: string;
  last_used_at: string | null;
}

export default function ApiKeys() {
  const { t } = useLanguage();
  const [keys, setKeys] = useState<ApiKey[]>();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    try {
      const res = await fetch('/api/keys', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch API keys');
      const data = await res.json();
      setKeys(data.keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const createKey = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to create API key');
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setCreating(false);
    }
  };

  const deleteKey = async (keyId: string) => {
    try {
      const res = await fetch(`/api/keys/${keyId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to delete API key');
      setDeleteConfirm(null);
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const copyToClipboard = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.apiKeys.title}</h1>
          <p className="text-gray-600 mt-1">{t.apiKeys.subtitle}</p>
        </div>
        <button
          onClick={createKey}
          disabled={creating}
          className="btn-primary flex items-center space-x-2"
        >
          {creating ? (
            <>
              <span className="animate-spin">⏳</span>
              <span>{t.apiKeys.creating}</span>
            </>
          ) : (
            <>
              <span>+</span>
              <span>{t.apiKeys.createNew}</span>
            </>
          )}
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700">
          {error}
        </div>
      )}

      {/* Info box */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <div className="flex items-start space-x-3">
          <span className="text-xl">ℹ️</span>
          <div className="text-sm text-blue-800">
            <p className="font-medium">{t.apiKeys.securityTitle}</p>
            <p className="mt-1">
              {t.apiKeys.securityDesc}
            </p>
          </div>
        </div>
      </div>

      {/* Keys list */}
      {loading ? (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-center space-x-4">
                <div className="h-10 bg-gray-200 rounded flex-1"></div>
                <div className="h-10 bg-gray-200 rounded w-24"></div>
              </div>
            ))}
          </div>
        </div>
      ) : keys.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">🔑</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{t.apiKeys.noKeys}</h3>
          <p className="text-gray-600 mb-4">{t.apiKeys.noKeysDesc}</p>
          <button onClick={createKey} disabled={creating} className="btn-primary">
            Create API Key
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                  {t.apiKeys.apiKey}
                </th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden sm:table-cell">
                  {t.apiKeys.created}
                </th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden md:table-cell">
                  {t.apiKeys.lastUsed}
                </th>
                <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                  {t.apiKeys.actions}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {keys.map((key) => (
                <tr key={key.key_id} className="hover:bg-gray-50">
                  <td className="px-4 py-4">
                    <div className="flex items-center space-x-2">
                      <code className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">
                        {key.key_id.slice(0, 8)}...{key.key_id.slice(-4)}
                      </code>
                      <button
                        onClick={() => copyToClipboard(key.key_id)}
                        className="text-gray-400 hover:text-gray-600 p-1"
                        title="Copy full key"
                      >
                        {copiedKey === key.key_id ? '✓' : '📋'}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-600 hidden sm:table-cell">
                    {formatDate(key.created_at)}
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-600 hidden md:table-cell">
                    {formatDate(key.last_used_at)}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {deleteConfirm === key.key_id ? (
                      <div className="flex items-center justify-end space-x-2">
                        <span className="text-sm text-gray-600">{t.apiKeys.deleteConfirm}</span>
                        <button
                          onClick={() => deleteKey(key.key_id)}
                          className="text-red-600 hover:text-red-700 text-sm font-medium"
                        >
                          {t.apiKeys.yes}
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="text-gray-600 hover:text-gray-700 text-sm"
                        >
                          {t.apiKeys.no}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(key.key_id)}
                        className="text-red-600 hover:text-red-700 text-sm font-medium"
                      >
                        {t.apiKeys.delete}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Usage example */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t.apiKeys.usageTitle}</h2>
        <p className="text-gray-600 mb-4">
          {t.apiKeys.usageDesc}
        </p>
        <code className="block bg-gray-50 rounded-lg p-4 text-sm font-mono text-gray-700 overflow-x-auto">
          Authorization: Bearer YOUR_API_KEY
        </code>
      </div>
    </div>
  );
}
