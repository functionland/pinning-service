import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

export default function Profile() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Company state
  const [company, setCompany] = useState('');
  const [companyLoading, setCompanyLoading] = useState(true);
  const [companySaving, setCompanySaving] = useState(false);
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [companySuccess, setCompanySuccess] = useState(false);

  useEffect(() => {
    fetchCompany();
  }, []);

  const fetchCompany = async () => {
    try {
      const res = await fetch('/api/profile/company', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCompany(data.company || '');
      }
    } catch (err) {
      console.error('Failed to fetch company:', err);
    } finally {
      setCompanyLoading(false);
    }
  };

  const handleSaveCompany = async () => {
    setCompanySaving(true);
    setCompanyError(null);
    setCompanySuccess(false);

    try {
      const res = await fetch('/api/profile/company', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ company: company.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save company');
      }

      setCompanySuccess(true);
      setTimeout(() => setCompanySuccess(false), 3000);
    } catch (err) {
      setCompanyError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setCompanySaving(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (deleteConfirmation !== 'delete') {
      setError('Please type "delete" to confirm');
      return;
    }

    setDeleting(true);
    setError(null);

    try {
      const res = await fetch('/api/profile', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ confirmation: deleteConfirmation }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete profile');
      }

      await logout();
      navigate('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.profile.title}</h1>
        <p className="text-gray-600 mt-1">{t.profile.subtitle}</p>
      </div>

      {/* Profile info */}
      <div className="card">
        <div className="flex items-center space-x-6">
          {user?.picture ? (
            <img
              src={user.picture}
              alt={user.name}
              className="h-20 w-20 rounded-full"
            />
          ) : (
            <div className="h-20 w-20 rounded-full bg-primary-100 flex items-center justify-center text-3xl">
              👤
            </div>
          )}
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{user?.name || t.common.user}</h2>
            <p className="text-gray-600">{user?.email}</p>
            <p className="text-sm text-gray-500 mt-1">
              {user?.provider === 'apple' ? 'Signed in with Apple' : t.profile.signedWith}
            </p>
          </div>
        </div>
      </div>

      {/* Company/Organization */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{t.profile?.company || 'Company / Organization'}</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t.profile?.companyLabel || 'Company Name'}
            </label>
            {companyLoading ? (
              <div className="animate-pulse h-10 bg-gray-100 rounded-lg"></div>
            ) : (
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder={t.profile?.companyPlaceholder || 'Enter your company or organization name'}
                className="w-full input"
                maxLength={100}
              />
            )}
            <p className="text-xs text-gray-500 mt-1">
              {t.profile?.companyHint || 'This helps identify your organization in reports'}
            </p>
          </div>
          {companyError && (
            <p className="text-sm text-red-600">{companyError}</p>
          )}
          {companySuccess && (
            <p className="text-sm text-green-600">{t.profile?.companySaved || 'Company saved successfully'}</p>
          )}
          <div className="flex justify-end">
            <button
              onClick={handleSaveCompany}
              disabled={companySaving || companyLoading}
              className="btn-primary px-4 py-2 disabled:opacity-50"
            >
              {companySaving ? (t.common?.saving || 'Saving...') : (t.common?.save || 'Save')}
            </button>
          </div>
        </div>
      </div>

      {/* Account info */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{t.profile.accountInfo}</h3>
        <div className="space-y-4">
          <div className="flex justify-between py-3 border-b border-gray-100">
            <span className="text-gray-600">{t.profile.email}</span>
            <span className="font-medium text-gray-900">{user?.email}</span>
          </div>
          <div className="flex justify-between py-3 border-b border-gray-100">
            <span className="text-gray-600">{t.profile.userId}</span>
            <span className="font-mono text-sm text-gray-700">{user?.email}</span>
          </div>
          <div className="flex justify-between py-3">
            <span className="text-gray-600">{t.profile.auth}</span>
            <span className="text-gray-900">
              {user?.provider === 'apple' ? 'Apple Sign-In' : t.profile.googleOAuth}
            </span>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div className="card border-red-200 bg-red-50">
        <h3 className="text-lg font-semibold text-red-800 mb-2">{t.profile.dangerTitle}</h3>
        <p className="text-red-700 text-sm mb-4">
          {t.profile.dangerDesc}
        </p>
        <button
          onClick={() => setShowDeleteModal(true)}
          className="btn-danger"
        >
          {t.profile.deleteAccount}
        </button>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b border-gray-100">
              <h2 className="text-xl font-semibold text-red-600">{t.profile.deleteTitle}</h2>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-800 font-medium">⚠️ {t.profile.deleteWarning}</p>
                <ul className="text-red-700 text-sm mt-2 space-y-1">
                  <li>• {t.profile.deletePins}</li>
                  <li>• {t.profile.deleteKeys}</li>
                  <li>• {t.profile.deleteData}</li>
                </ul>
              </div>

              {error && (
                <div className="bg-red-100 border border-red-300 rounded-lg p-3 text-red-700 text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t.profile.confirmLabel}
                </label>
                <input
                  type="text"
                  value={deleteConfirmation}
                  onChange={(e) => setDeleteConfirmation(e.target.value)}
                  placeholder="delete"
                  className="input"
                  autoComplete="off"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  onClick={() => {
                    setShowDeleteModal(false);
                    setDeleteConfirmation('');
                    setError(null);
                  }}
                  className="btn-secondary"
                >
                  {t.pins.cancel}
                </button>
                <button
                  onClick={handleDeleteProfile}
                  disabled={deleting || deleteConfirmation !== 'delete'}
                  className="btn-danger disabled:opacity-50"
                >
                  {deleting ? t.profile.deleting : t.profile.deleteAccount}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
