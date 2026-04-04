import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import ReferralTree from '../components/ReferralTree';

interface LevelStats {
  count: number;
  credits: number;
}

interface ReferralCode {
  code: string;
  name: string | null;
  displayName: string | null;
  inheritedName: string | null;
  isDefault: boolean;
  createdAt: string;
}

interface ReferralInfo {
  codes: ReferralCode[];
  code: string; // Legacy default code
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
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingCode, setEditingCode] = useState<ReferralCode | null>(null);
  const [modalName, setModalName] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

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

  const getReferralLink = (code: string) => {
    return `${window.location.origin}/login?ref=${code}&redirect=/download`;
  };

  // Email-to-hash search for finding referrals
  const [searchEmail, setSearchEmail] = useState('');
  const [highlightUserId, setHighlightUserId] = useState<string | undefined>(undefined);

  const emailToHash = useCallback(async (email: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(email.trim().toLowerCase());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchEmail.trim()) {
      setHighlightUserId(undefined);
      return;
    }
    const hash = await emailToHash(searchEmail);
    setHighlightUserId(hash);
  }, [searchEmail, emailToHash]);

  const copyToClipboard = async (text: string, code: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCreateCode = async () => {
    setModalLoading(true);
    setModalError(null);
    try {
      const res = await fetch('/api/referral/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: modalName.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create referral code');
      }
      setShowCreateModal(false);
      setModalName('');
      fetchReferralInfo();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setModalLoading(false);
    }
  };

  const handleEditCode = async () => {
    if (!editingCode) return;
    setModalLoading(true);
    setModalError(null);
    try {
      const res = await fetch(`/api/referral/codes/${editingCode.code}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: modalName.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update referral code');
      }
      setShowEditModal(false);
      setEditingCode(null);
      setModalName('');
      fetchReferralInfo();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setModalLoading(false);
    }
  };

  const handleDeleteCode = async (code: string) => {
    if (!confirm('Are you sure you want to delete this referral code?')) return;
    try {
      const res = await fetch(`/api/referral/codes/${code}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to delete referral code');
        return;
      }
      fetchReferralInfo();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const openEditModal = (code: ReferralCode) => {
    setEditingCode(code);
    setModalName(code.name || '');
    setModalError(null);
    setShowEditModal(true);
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

      {/* Referral Links Card */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">{t.referrals?.yourLinks || 'Your Referral Links'}</h2>
          {info && info.codes.length < 10 && (
            <button
              onClick={() => {
                setModalName('');
                setModalError(null);
                setShowCreateModal(true);
              }}
              className="btn-primary text-sm px-3 py-1.5"
            >
              + {t.referrals?.createNew || 'Create New Link'}
            </button>
          )}
        </div>

        {info ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 font-medium text-gray-600">{t.referrals?.labelColumn || 'Label'}</th>
                  <th className="text-left py-2 px-2 font-medium text-gray-600">{t.referrals?.codeColumn || 'Code'}</th>
                  <th className="text-left py-2 px-2 font-medium text-gray-600 hidden md:table-cell">{t.referrals?.linkColumn || 'Link'}</th>
                  <th className="text-right py-2 px-2 font-medium text-gray-600">{t.referrals?.actionsColumn || 'Actions'}</th>
                </tr>
              </thead>
              <tbody>
                {info.codes.map((codeItem) => (
                  <tr key={codeItem.code} className="border-b border-gray-100 hover:bg-gray-50">
                    {/* Label */}
                    <td className="py-3 px-2">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-900">
                          {codeItem.displayName || (
                            <span className="text-gray-400 italic">{t.referrals?.noLabel || 'No label'}</span>
                          )}
                        </span>
                        {codeItem.isDefault && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                            {t.referrals?.defaultBadge || 'Default'}
                          </span>
                        )}
                        {!codeItem.name && codeItem.inheritedName && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                            {t.referrals?.inheritedBadge || 'Inherited'}
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Code */}
                    <td className="py-3 px-2">
                      <code className="font-mono text-primary-600 font-semibold">{codeItem.code}</code>
                    </td>
                    {/* Link (hidden on mobile) */}
                    <td className="py-3 px-2 hidden md:table-cell">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          readOnly
                          value={getReferralLink(codeItem.code)}
                          className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 text-gray-600"
                        />
                      </div>
                    </td>
                    {/* Actions */}
                    <td className="py-3 px-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => copyToClipboard(getReferralLink(codeItem.code), codeItem.code)}
                          className="text-xs px-2 py-1 rounded bg-primary-50 text-primary-600 hover:bg-primary-100 transition-colors"
                          title={t.referrals?.copyLink || 'Copy Link'}
                        >
                          {copiedCode === codeItem.code ? (t.referrals?.copied || 'Copied!') : (t.referrals?.copy || 'Copy')}
                        </button>
                        <button
                          onClick={() => openEditModal(codeItem)}
                          className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                          title={t.referrals?.editLabel || 'Edit Label'}
                        >
                          {t.referrals?.edit || 'Edit'}
                        </button>
                        {!codeItem.isDefault && (
                          <button
                            onClick={() => handleDeleteCode(codeItem.code)}
                            className="text-xs px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                            title={t.referrals?.delete || 'Delete'}
                          >
                            {t.referrals?.delete || 'Delete'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="animate-pulse h-24 bg-gray-100 rounded-lg"></div>
        )}

        {info && info.codes.length >= 10 && (
          <p className="text-sm text-gray-500 mt-3">
            {t.referrals?.maxCodesReached || 'Maximum of 10 referral links reached'}
          </p>
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
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t.referrals?.referredUsers || 'Referred Users'}
            <span className="text-sm font-normal text-gray-500 ml-2">
              ({t.referrals?.expandHint || 'Click arrow to expand referral chain'})
            </span>
          </h2>

          {/* Email search */}
          <div className="flex items-center gap-2">
            <input
              type="email"
              value={searchEmail}
              onChange={(e) => setSearchEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder={t.referrals?.searchPlaceholder || 'Search by email...'}
              className="input text-sm px-3 py-1.5 w-48 sm:w-56"
            />
            <button
              onClick={handleSearch}
              className="btn-secondary text-sm px-3 py-1.5"
            >
              {t.referrals?.search || 'Search'}
            </button>
            {highlightUserId && (
              <button
                onClick={() => { setHighlightUserId(undefined); setSearchEmail(''); }}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                {t.common?.clear || 'Clear'}
              </button>
            )}
          </div>
        </div>

        {user?.userId ? (
          <div className="overflow-x-auto">
            <ReferralTree
              userId={user.userId}
              level={1}
              maxLevel={3}
              isAdmin={false}
              highlightUserId={highlightUserId}
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

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {t.referrals?.createModalTitle || 'Create New Referral Link'}
            </h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t.referrals?.labelInput || 'Label (optional)'}
              </label>
              <input
                type="text"
                value={modalName}
                onChange={(e) => setModalName(e.target.value)}
                placeholder={t.referrals?.labelPlaceholder || 'e.g., My Company, Twitter Campaign'}
                className="w-full input"
                maxLength={50}
              />
              <p className="text-xs text-gray-500 mt-1">
                {t.referrals?.labelHint || 'This label will be inherited by users who sign up with this link'}
              </p>
            </div>
            {modalError && (
              <p className="text-sm text-red-600 mb-4">{modalError}</p>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowCreateModal(false)}
                className="btn-secondary px-4 py-2"
                disabled={modalLoading}
              >
                {t.common?.cancel || 'Cancel'}
              </button>
              <button
                onClick={handleCreateCode}
                className="btn-primary px-4 py-2"
                disabled={modalLoading}
              >
                {modalLoading ? (t.common?.creating || 'Creating...') : (t.common?.create || 'Create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && editingCode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {t.referrals?.editModalTitle || 'Edit Referral Link Label'}
            </h3>
            <div className="mb-2">
              <p className="text-sm text-gray-600">
                {t.referrals?.editingCode || 'Code'}: <code className="font-mono font-semibold text-primary-600">{editingCode.code}</code>
              </p>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t.referrals?.labelInput || 'Label'}
              </label>
              <input
                type="text"
                value={modalName}
                onChange={(e) => setModalName(e.target.value)}
                placeholder={t.referrals?.labelPlaceholder || 'e.g., My Company, Twitter Campaign'}
                className="w-full input"
                maxLength={50}
              />
              {editingCode.inheritedName && !modalName && (
                <p className="text-xs text-purple-600 mt-1">
                  {t.referrals?.inheritedFrom || 'Inherited label'}: {editingCode.inheritedName}
                </p>
              )}
            </div>
            {modalError && (
              <p className="text-sm text-red-600 mb-4">{modalError}</p>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowEditModal(false);
                  setEditingCode(null);
                }}
                className="btn-secondary px-4 py-2"
                disabled={modalLoading}
              >
                {t.common?.cancel || 'Cancel'}
              </button>
              <button
                onClick={handleEditCode}
                className="btn-primary px-4 py-2"
                disabled={modalLoading}
              >
                {modalLoading ? (t.common?.saving || 'Saving...') : (t.common?.save || 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
