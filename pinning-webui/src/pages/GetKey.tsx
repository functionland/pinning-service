import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

export default function GetKey() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useLanguage();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [finalRedirectUrl, setFinalRedirectUrl] = useState<string | null>(null);

  const redirectUrl = searchParams.get('redirect');
  const platformParam = searchParams.get('platform');
  // `mode` (A/B/C) — passed by the FxFiles app to lock the web sign-in
  // UI to whichever vault mode the user picked in-app. Forwarded
  // through the /login bounce so /login can render only the matching
  // mode card.
  const modeParam = searchParams.get('mode');

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
      let currentUrl = `/get-key?redirect=${encodeURIComponent(redirectUrl)}`;
      if (platformParam) {
        currentUrl += `&platform=${encodeURIComponent(platformParam)}`;
      }
      if (modeParam) {
        currentUrl += `&mode=${encodeURIComponent(modeParam)}`;
      }
      let loginUrl = `/login?returnTo=${encodeURIComponent(currentUrl)}`;
      if (platformParam) {
        loginUrl += `&platform=${encodeURIComponent(platformParam)}`;
      }
      if (modeParam) {
        loginUrl += `&mode=${encodeURIComponent(modeParam)}`;
      }
      navigate(loginUrl, { replace: true });
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
        // Include user identity so the app can create a user session
        if (user) {
          url.searchParams.set('email', user.email);
          url.searchParams.set('name', user.name);
          url.searchParams.set('id', user.id);
          url.searchParams.set('provider', user.provider);
          if (user.picture) {
            url.searchParams.set('picture', user.picture);
          }
        }
        const fullUrl = url.toString();

        // Store the URL for manual redirect button
        setFinalRedirectUrl(fullUrl);
        setProcessing(false);

        // Try automatic redirect (may be blocked by browser)
        window.location.href = fullUrl;
      } catch (err) {
        console.error('[GetKey] Error:', err);
        setError(err instanceof Error ? err.message : 'An error occurred');
        setProcessing(false);
      }
    };

    fetchKeyAndRedirect();
  }, [user, loading, redirectUrl, platformParam, modeParam, navigate]);

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

  // Show success state with manual redirect button
  if (finalRedirectUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
            <div className="text-5xl mb-4">✓</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">API Key Retrieved!</h1>
            <p className="text-gray-600 mb-6">
              Click the button below to continue to FxFiles app. If the app doesn't open automatically, you may need to allow redirects in your browser settings.
            </p>
            <a
              href={finalRedirectUrl}
              className="btn-primary inline-block"
            >
              Continue to FxFiles
            </a>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
