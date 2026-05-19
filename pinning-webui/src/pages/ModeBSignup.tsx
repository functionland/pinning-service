/**
 * Mode B (OAuth + password) sign-in / sign-up screen for pinning-webui.
 *
 * Mirrors the FxFiles `mode_b_signin_screen.dart` flow:
 *   1. user enters a password
 *   2. user picks Google or Apple
 *   3. browser does the OAuth dance, gets the ID token
 *   4. AuthContext.loginWithModeB:
 *        - computes effective_user_id_hex locally (WASM)
 *        - derives the OAuth-bound Ed25519 signing keypair (WASM)
 *        - fetches a server-issued single-use challenge nonce
 *        - signs the transcript and POSTs to /auth/register-mode-b
 *        - server verifies OAuth + signature, sets session cookie,
 *          returns { user, has_mode_a, ... }
 *   5. if `has_mode_a` we warn the user that this is a separate vault
 *      from any pre-existing Mode A account on the same OAuth identity
 *
 * The endpoint is idempotent on (effective_user_id, public_key) so
 * returning users on a new browser go through the same path with no
 * extra "sign-in" branch.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface AppleSignInResponse {
  authorization: {
    code: string;
    id_token: string;
    state?: string;
  };
  user?: {
    email?: string;
    name?: {
      firstName?: string;
      lastName?: string;
    };
  };
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            ux_mode?: 'popup' | 'redirect';
            itp_support?: boolean;
          }) => void;
          renderButton: (
            element: HTMLElement,
            config: {
              theme?: string;
              size?: string;
              width?: number;
              text?: string;
              shape?: string;
            },
          ) => void;
          prompt: () => void;
        };
      };
    };
    AppleID?: {
      auth: {
        init: (config: {
          clientId: string;
          scope: string;
          redirectURI: string;
          usePopup: boolean;
        }) => void;
        signIn: () => Promise<AppleSignInResponse>;
      };
    };
  }
}

export default function ModeBSignup() {
  const { loginWithModeB } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasModeAWarning, setHasModeAWarning] = useState(false);

  // Google button initialization. We re-render the button whenever
  // `password` becomes non-empty so the password is captured in the
  // closure passed to the callback. (Google's renderButton has no
  // post-click hook to read live state.)
  const handleGoogleCredential = useCallback(
    async (response: { credential: string }) => {
      if (!password) {
        setError('Enter a password first.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await loginWithModeB({
          provider: 'google',
          oauthToken: response.credential,
          password,
        });
        if (result.hasModeA) {
          setHasModeAWarning(true);
        } else {
          navigate('/', { replace: true });
        }
      } catch (e) {
        const err = e as Error & { code?: string };
        setBusy(false);
        setError(humanizeError(err));
      }
    },
    [loginWithModeB, navigate, password],
  );

  useEffect(() => {
    if (!password || busy) return;
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
    if (!clientId) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (!window.google) {
        window.setTimeout(tick, 80);
        return;
      }
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredential,
        ux_mode: 'popup',
        itp_support: true,
      });
      const slot = document.getElementById('mode-b-google-button');
      if (slot) {
        // Clear any prior render so re-renders don't stack overlays.
        slot.innerHTML = '';
        window.google.accounts.id.renderButton(slot, {
          theme: 'outline',
          size: 'large',
          width: 280,
          text: 'continue_with',
          shape: 'rectangular',
        });
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [password, busy, handleGoogleCredential]);

  const handleAppleSignIn = useCallback(async () => {
    if (!password) {
      setError('Enter a password first.');
      return;
    }
    const appleClientId = import.meta.env.VITE_APPLE_CLIENT_ID || '';
    if (!appleClientId) {
      setError('Apple Sign-In is not configured on this site.');
      return;
    }
    if (!window.AppleID) {
      setError('Apple Sign-In script not loaded — retry in a moment.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      window.AppleID.auth.init({
        clientId: appleClientId,
        scope: 'name email',
        redirectURI: window.location.origin + '/login/mode-b',
        usePopup: true,
      });
      const response = await window.AppleID.auth.signIn();
      const result = await loginWithModeB({
        provider: 'apple',
        oauthToken: response.authorization.id_token,
        appleUser: response.user,
        password,
      });
      if (result.hasModeA) {
        setHasModeAWarning(true);
      } else {
        navigate('/', { replace: true });
      }
    } catch (e) {
      const err = e as Error & { code?: string; message: string };
      setBusy(false);
      if (err.message?.includes('popup_closed')) {
        // User cancelled the Apple popup — silent.
        return;
      }
      setError(humanizeError(err));
    }
  }, [loginWithModeB, navigate, password]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-gray-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg p-8">
          <div className="text-center mb-6">
            <div className="text-4xl mb-2">🛡️</div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">
              Maximum-security vault
            </h1>
            <p className="text-sm text-gray-600">
              Your password is mixed with your Google/Apple identity into the
              encryption key. Both are required to access your files.
            </p>
          </div>

          <div className="mb-4">
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                placeholder="Choose a strong password"
                className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                disabled={busy}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-700"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="text-[11px] text-orange-600 mt-1">
              If you forget this password, your files become unrecoverable. Pick
              something you'll remember.
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-col items-center gap-3">
            {/* Google */}
            {password ? (
              <div id="mode-b-google-button"></div>
            ) : (
              <button
                disabled
                className="flex items-center justify-center gap-3 w-[280px] h-[44px] bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-400 cursor-not-allowed"
              >
                Continue with Google
              </button>
            )}

            {/* Apple */}
            <button
              onClick={handleAppleSignIn}
              disabled={!password || busy}
              className="flex items-center justify-center gap-3 w-[280px] h-[44px] bg-black text-white rounded-md hover:bg-gray-800 transition-colors font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
              </svg>
              Continue with Apple
            </button>
          </div>

          <div className="mt-6 pt-4 border-t border-gray-100 text-center">
            <Link
              to="/login"
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              ← Back to mode selection
            </Link>
          </div>
        </div>
      </div>

      {/* Mode-A-exists warning: server tells us this OAuth identity
          already has a Mode A vault. The new Mode B vault is SEPARATE —
          existing files won't appear here. */}
      {hasModeAWarning && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <div className="text-center mb-4">
              <div className="text-4xl mb-2">⚠️</div>
              <h2 className="text-lg font-bold text-gray-900">
                Existing vault detected
              </h2>
            </div>
            <p className="text-sm text-gray-700 mb-4">
              You already have a Standard-security (Mode A) vault on this
              Google/Apple account. The Maximum-security vault you just created
              is <strong>separate</strong> — your existing files are NOT in
              this vault.
            </p>
            <p className="text-sm text-gray-700 mb-6">
              To access your old files, sign out and sign in with Standard
              security (no password). To keep using the new vault, continue.
            </p>
            <button
              onClick={() => {
                setHasModeAWarning(false);
                navigate('/', { replace: true });
              }}
              className="w-full px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-md text-sm font-medium"
            >
              I understand
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function humanizeError(err: Error & { code?: string }): string {
  switch (err.code) {
    case 'PUBLIC_KEY_MISMATCH':
      return 'A vault already exists for this account with a different password. Use the original password, or contact support.';
    case 'SIGNATURE_INVALID':
      return 'Authentication failed. This is a bug — please report it.';
    case 'VALIDATION_ERROR':
      return 'Bad input format. Please try again.';
    case 'CHALLENGE_INVALID':
      return 'Your sign-in attempt expired. Please try again.';
    default:
      return err.message || String(err);
  }
}
