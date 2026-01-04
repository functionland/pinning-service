import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

export default function GetKey() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useLanguage();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const redirectUrl = searchParams.get('redirect');

  useEffect(() => {
    // Wait for auth to finish loading
    if (loading) return;

    // Validate redirect parameter exists
    if (!redirectUrl) {
      setError('Missing redirect parameter. Please provide a redirect URL.');
      return;
    }

    // Validate redirect URL format
    try {
      // Check if it's a valid URL (can be custom scheme like fxblox://)
      const url = new URL(redirectUrl);
      // Allow custom app schemes and standard http/https
      const allowedSchemes = ['fxblox:', 'fxfiles:', 'files:', 'http:', 'https:'];
      if (!allowedSchemes.includes(url.protocol)) {
        setError(`Invalid redirect URL scheme. Allowed: ${allowedSchemes.join(', ')}`);
        return;
      }
    } catch {
      setError('Invalid redirect URL format.');
      return;
    }

    // If user is not logged in, redirect to login with returnTo
    if (!user) {
      const currentUrl = `/get-key?redirect=${encodeURIComponent(redirectUrl)}`;
      navigate(`/login?returnTo=${encodeURIComponent(currentUrl)}`, { replace: true });
      return;
    }

    // User is logged in, fetch the API key and redirect
    const fetchKeyAndRedirect = async () => {
      setProcessing(true);
      try {
        const res = await fetch('/api/keys/active', { credentials: 'include' });
        if (!res.ok) {
          throw new Error('Failed to fetch API key');
        }
        const data = await res.json();

        if (!data.key) {
          throw new Error('No API key returned');
        }

        // Construct the redirect URL with the key parameter
        const url = new URL(redirectUrl);
        url.searchParams.set('key', data.key);

        // Redirect to the external URL
        window.location.href = url.toString();
      } catch (err) {
        console.error('[GetKey] Error:', err);
        setError(err instanceof Error ? err.message : 'An error occurred');
        setProcessing(false);
      }
    };

    fetchKeyAndRedirect();
  }, [user, loading, redirectUrl, navigate]);

  // Show loading state
  if (loading || processing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600">
            {processing ? 'Retrieving your API key...' : t.common.loading}
          </p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
            <div className="text-5xl mb-4">X</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Error</h1>
            <p className="text-gray-600 mb-6">{error}</p>
            <button
              onClick={() => navigate('/')}
              className="btn-primary"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
