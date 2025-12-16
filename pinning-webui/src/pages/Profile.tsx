import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Profile() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <h1 className="text-2xl font-bold text-gray-900">Profile</h1>
        <p className="text-gray-600 mt-1">Manage your account settings</p>
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
            <h2 className="text-xl font-semibold text-gray-900">{user?.name || 'User'}</h2>
            <p className="text-gray-600">{user?.email}</p>
            <p className="text-sm text-gray-500 mt-1">Signed in with Google</p>
          </div>
        </div>
      </div>

      {/* Account info */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Account Information</h3>
        <div className="space-y-4">
          <div className="flex justify-between py-3 border-b border-gray-100">
            <span className="text-gray-600">Email</span>
            <span className="font-medium text-gray-900">{user?.email}</span>
          </div>
          <div className="flex justify-between py-3 border-b border-gray-100">
            <span className="text-gray-600">User ID</span>
            <span className="font-mono text-sm text-gray-700">{user?.email}</span>
          </div>
          <div className="flex justify-between py-3">
            <span className="text-gray-600">Authentication</span>
            <span className="text-gray-900">Google OAuth</span>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div className="card border-red-200 bg-red-50">
        <h3 className="text-lg font-semibold text-red-800 mb-2">Danger Zone</h3>
        <p className="text-red-700 text-sm mb-4">
          Once you delete your account, there is no going back. All your pins and data will be permanently deleted.
        </p>
        <button
          onClick={() => setShowDeleteModal(true)}
          className="btn-danger"
        >
          Delete My Account
        </button>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b border-gray-100">
              <h2 className="text-xl font-semibold text-red-600">Delete Account</h2>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-800 font-medium">⚠️ This action cannot be undone</p>
                <ul className="text-red-700 text-sm mt-2 space-y-1">
                  <li>• All your pins will be permanently deleted</li>
                  <li>• All your API keys will be revoked</li>
                  <li>• Your account data will be completely removed</li>
                </ul>
              </div>

              {error && (
                <div className="bg-red-100 border border-red-300 rounded-lg p-3 text-red-700 text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type <span className="font-mono font-bold">delete</span> to confirm
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
                  Cancel
                </button>
                <button
                  onClick={handleDeleteProfile}
                  disabled={deleting || deleteConfirmation !== 'delete'}
                  className="btn-danger disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Delete My Account'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
