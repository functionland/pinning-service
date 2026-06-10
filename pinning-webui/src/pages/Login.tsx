import { useEffect, useCallback, useState, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import LanguageSelector from '../components/LanguageSelector';

function useAnimatedCounter(targetValue: number, duration: number = 5000) {
  const [displayValue, setDisplayValue] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const startValueRef = useRef(0);

  useEffect(() => {
    if (targetValue <= 0) return;

    // Start from ~70% of actual value for dramatic effect
    const startValue = Math.floor(targetValue * 0.7);
    startValueRef.current = startValue;
    setDisplayValue(startValue);
    startTimeRef.current = null;

    const animate = (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      
      // Ease out cubic for smooth deceleration
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const currentValue = startValueRef.current + (targetValue - startValueRef.current) * easeOut;
      
      setDisplayValue(Math.floor(currentValue));
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setDisplayValue(targetValue);
      }
    };

    requestAnimationFrame(animate);
  }, [targetValue, duration]);

  return displayValue;
}

function formatStorageSize(bytes: number): { value: string; unit: string } {
  if (bytes === 0) return { value: '0', unit: 'MB' };
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) {
    const gb = mb / 1024;
    return { value: gb.toFixed(1), unit: 'GB' };
  }
  return { value: mb.toFixed(1), unit: 'MB' };
}

// Apple Sign-In response type
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
          renderButton: (element: HTMLElement, config: {
            theme?: string;
            size?: string;
            width?: number;
            text?: string;
            shape?: string;
          }) => void;
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

interface PricingInfo {
  freeTierMB: number;
  fulaPerGBMonth: number;
}

const REFERRAL_CODE_KEY = 'fula-referral-code';
const REFERRAL_REDIRECT_KEY = 'fula-referral-redirect';

export default function Login() {
  const { user, login, loginWithApple } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useLanguage();
  const [totalSize, setTotalSize] = useState(0);
  const [totalPins, setTotalPins] = useState(0);
  const [pricing, setPricing] = useState<PricingInfo | null>(null);
  const animatedSize = useAnimatedCounter(totalSize, 5000);
  const animatedPins = useAnimatedCounter(totalPins, 5000);
  const formattedSize = formatStorageSize(animatedSize);
  const returnTo = searchParams.get('returnTo');
  const redirectParam = searchParams.get('redirect');
  const platformParam = searchParams.get('platform')?.toLowerCase(); // 'google', 'apple', or null (show both)
  // `mode` (A/B/C): when set, render ONLY the matching vault mode card
  // and hide the other two. Sent by the FxFiles app so a user who
  // picked Mode B in-app can't accidentally click Mode A on the web
  // (which would create a separate vault under the same OAuth identity).
  const modeParam = searchParams.get('mode')?.toLowerCase();
  const showModeA = !modeParam || modeParam === 'a';
  const showModeB = !modeParam || modeParam === 'b';
  const showModeC = !modeParam || modeParam === 'c';
  // Preserve the platform pin AND any `returnTo` (e.g. the /get-key →
  // /login bounce sets `returnTo=<encoded /get-key URL>` so that after
  // the Mode B/C sign-in the user is taken back to /get-key to fetch
  // the API key and trigger the fxfiles://auth-callback handoff).
  // Without forwarding returnTo, ModeBSignup defaults to `/` and the
  // FxFiles app never receives its JWT.
  const subpathQuery = (() => {
    const params: string[] = [];
    if (platformParam) params.push(`platform=${encodeURIComponent(platformParam)}`);
    if (returnTo) params.push(`returnTo=${encodeURIComponent(returnTo)}`);
    return params.length > 0 ? `?${params.join('&')}` : '';
  })();

  // Capture referral code and redirect from URL and store in localStorage (keep first code only)
  useEffect(() => {
    const refCode = searchParams.get('ref');
    const redirect = searchParams.get('redirect');
    if (refCode && !localStorage.getItem(REFERRAL_CODE_KEY)) {
      localStorage.setItem(REFERRAL_CODE_KEY, refCode);
      // Also store redirect URL if provided with the referral code
      if (redirect && redirect.startsWith('/')) {
        localStorage.setItem(REFERRAL_REDIRECT_KEY, redirect);
      }
    }
  }, [searchParams]);

  // Fetch public stats and pricing on mount
  useEffect(() => {
    fetch('/api/public/stats')
      .then(res => res.json())
      .then(data => {
        if (data.totalSize) {
          setTotalSize(data.totalSize);
        }
        if (data.totalPins) {
          setTotalPins(data.totalPins);
        }
      })
      .catch(err => console.error('Failed to fetch stats:', err));

    fetch('/api/credits/pricing')
      .then(res => res.json())
      .then(data => {
        setPricing({
          freeTierMB: data.freeTierMB || 500,
          fulaPerGBMonth: data.fulaPerGBMonth || 3,
        });
      })
      .catch(err => console.error('Failed to fetch pricing:', err));
  }, []);

  const handleCredentialResponse = useCallback(async (response: { credential: string }) => {
    console.log('[Login] Google credential received, length:', response.credential?.length);
    try {
      // Get referral code from localStorage
      const referralCode = localStorage.getItem(REFERRAL_CODE_KEY) || undefined;

      const result = await login(response.credential, referralCode);
      console.log('[Login] Login successful, isNew:', result.isNew);

      // Get stored redirect before clearing localStorage
      const storedRedirect = localStorage.getItem(REFERRAL_REDIRECT_KEY);

      // Clear referral data from localStorage after login
      if (result.isNew) {
        localStorage.removeItem(REFERRAL_CODE_KEY);
      }
      localStorage.removeItem(REFERRAL_REDIRECT_KEY);

      // Priority 1: Check for redirect param in URL (works for all users)
      if (redirectParam && redirectParam.startsWith('/')) {
        navigate(redirectParam, { replace: true });
        return;
      }

      // Priority 2: Check for stored redirect in localStorage (fallback)
      if (storedRedirect && storedRedirect.startsWith('/')) {
        navigate(storedRedirect, { replace: true });
        return;
      }

      // Priority 3: If there's a returnTo parameter, navigate there after login
      if (returnTo && returnTo.startsWith('/')) {
        navigate(returnTo, { replace: true });
        return;
      }

      // Default: Navigate to dashboard
      if (result.isNew) {
        navigate('/?welcome=true');
      } else {
        navigate('/');
      }
    } catch (error) {
      console.error('[Login] Login failed:', error);
      alert('Login failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }, [login, navigate, returnTo, redirectParam]);

  const handleAppleSignIn = useCallback(async () => {
    console.log('[Login] Apple Sign-In clicked');
    try {
      const appleClientId = import.meta.env.VITE_APPLE_CLIENT_ID || '';

      if (!appleClientId) {
        console.error('[Login] VITE_APPLE_CLIENT_ID is not set!');
        alert('Apple Sign-In is not configured');
        return;
      }

      if (!window.AppleID) {
        console.error('[Login] Apple Sign-In SDK not loaded');
        alert('Apple Sign-In is not available. Please try again later.');
        return;
      }

      // Initialize Apple Sign-In
      window.AppleID.auth.init({
        clientId: appleClientId,
        scope: 'name email',
        redirectURI: window.location.origin + '/login',
        usePopup: true,
      });

      // Trigger sign-in
      const response = await window.AppleID.auth.signIn();
      console.log('[Login] Apple response received');

      // Get referral code from localStorage
      const referralCode = localStorage.getItem(REFERRAL_CODE_KEY) || undefined;

      // Send to backend
      const result = await loginWithApple(
        response.authorization.id_token,
        response.user,
        referralCode
      );
      console.log('[Login] Apple login successful, isNew:', result.isNew);

      // Get stored redirect before clearing localStorage
      const storedRedirect = localStorage.getItem(REFERRAL_REDIRECT_KEY);

      // Clear referral data from localStorage after login
      if (result.isNew) {
        localStorage.removeItem(REFERRAL_CODE_KEY);
      }
      localStorage.removeItem(REFERRAL_REDIRECT_KEY);

      // Priority 1: Check for redirect param in URL
      if (redirectParam && redirectParam.startsWith('/')) {
        navigate(redirectParam, { replace: true });
        return;
      }

      // Priority 2: Check for stored redirect in localStorage
      if (storedRedirect && storedRedirect.startsWith('/')) {
        navigate(storedRedirect, { replace: true });
        return;
      }

      // Priority 3: returnTo parameter
      if (returnTo && returnTo.startsWith('/')) {
        navigate(returnTo, { replace: true });
        return;
      }

      // Default: Navigate to dashboard
      if (result.isNew) {
        navigate('/?welcome=true');
      } else {
        navigate('/');
      }
    } catch (error) {
      console.error('[Login] Apple login failed:', error);
      // Don't show alert for user cancellation
      if (error instanceof Error && !error.message.includes('popup_closed')) {
        alert('Apple login failed: ' + error.message);
      }
    }
  }, [loginWithApple, navigate, returnTo, redirectParam]);

  useEffect(() => {
    if (user) {
      // Priority 1: redirect param
      if (redirectParam && redirectParam.startsWith('/')) {
        navigate(redirectParam, { replace: true });
        return;
      }
      // Priority 2: returnTo param
      if (returnTo && returnTo.startsWith('/')) {
        navigate(returnTo, { replace: true });
        return;
      }
      // Default: dashboard
      navigate('/');
      return;
    }

    const initializeGoogle = () => {
      if (window.google) {
        const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
        console.log('[Login] Initializing Google Sign-In, client_id present:', !!clientId, 'length:', clientId.length);
        
        if (!clientId) {
          console.error('[Login] VITE_GOOGLE_CLIENT_ID is not set!');
          return;
        }
        
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleCredentialResponse,
          ux_mode: 'popup',
          itp_support: true,
        });

        const buttonDiv = document.getElementById('google-signin-button');
        if (buttonDiv) {
          window.google.accounts.id.renderButton(buttonDiv, {
            theme: 'outline',
            size: 'large',
            width: 280,
            text: 'signin_with',
            shape: 'rectangular',
          });
        }
      }
    };

    // Wait for Google script to load (only if Google sign-in is shown)
    if (!platformParam || platformParam === 'google') {
      if (window.google) {
        initializeGoogle();
      } else {
        const checkGoogle = setInterval(() => {
          if (window.google) {
            clearInterval(checkGoogle);
            initializeGoogle();
          }
        }, 100);

        return () => clearInterval(checkGoogle);
      }
    }
  }, [user, navigate, handleCredentialResponse, returnTo, redirectParam, platformParam]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-gray-100 flex flex-col items-center justify-center p-4">
      {/* Language selector - top right */}
      <div className="absolute top-4 right-4">
        <LanguageSelector />
      </div>

      <div className="w-full max-w-md">
        {/* Logo and title */}
        <div className="text-center mb-8">
          <img
            src="/logo.svg"
            alt="FULA"
            className="mx-auto mb-6 h-24"
          />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {t.login.title}
          </h1>
          <p className="text-gray-600">
            {t.login.subtitle}
          </p>
        </div>

        {/* Storage counter */}
        {(totalSize > 0 || totalPins > 0) && (
          <div className="bg-white/80 backdrop-blur rounded-xl shadow-sm p-6 mb-6">
            <div className="flex justify-center gap-8">
              {totalPins > 0 && (
                <div className="text-center">
                  <p className="text-sm text-gray-500 mb-1">{t.login.totalPins}</p>
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-4xl font-bold text-primary-600 tabular-nums">
                      {animatedPins.toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
              {totalSize > 0 && (
                <div className="text-center">
                  <p className="text-sm text-gray-500 mb-1">{t.login.totalStored}</p>
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-4xl font-bold text-primary-600 tabular-nums">
                      {formattedSize.value}
                    </span>
                    <span className="text-xl font-medium text-primary-500">
                      {formattedSize.unit}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Mode chooser — three vault security tiers, mirroring the
            FxFiles ModeChoiceScreen layout. Mode A signs in inline via
            Google / Apple (no extra screen — it's just two buttons).
            Mode B (OAuth + password) and Mode C (passphrase-only with
            24-word recovery) navigate to dedicated /login/mode-{b,c}
            pages because they each have a multi-step flow. */}
        <div className="bg-white rounded-2xl shadow-lg p-6 space-y-3">
          <h2 className="text-xl font-semibold text-gray-900 mb-1 text-center">
            Choose how to secure your vault
          </h2>
          <p className="text-sm text-gray-500 text-center mb-4">
            Your files are end-to-end encrypted on every option. Pick the level of protection you want.
          </p>

          {/* Mode B — Maximum Security (Recommended) */}
          {showModeB && (
          <Link
            to={`/login/mode-b${subpathQuery}`}
            className="block rounded-xl border border-gray-200 hover:border-green-500 hover:shadow-md transition-all p-4 group"
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 text-2xl">🛡️</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-semibold text-gray-900">Maximum Security</h3>
                  <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-green-100 text-green-700">
                    Recommended
                  </span>
                </div>
                <p className="text-xs text-gray-600 mb-2">
                  Google/Apple <strong>plus</strong> a password. A leak of your Google or Apple account alone does NOT expose your files.
                </p>
                <p className="text-xs text-primary-600 group-hover:underline">
                  Continue with password →
                </p>
              </div>
            </div>
          </Link>
          )}

          {/* Mode C — Maximum Privacy (Advanced) */}
          {showModeC && (
          <Link
            to={`/login/mode-c${subpathQuery}`}
            className="block rounded-xl border border-gray-200 hover:border-purple-500 hover:shadow-md transition-all p-4 group"
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 text-2xl">🔑</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-semibold text-gray-900">Maximum Privacy</h3>
                  <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-purple-100 text-purple-700">
                    Advanced
                  </span>
                </div>
                <p className="text-xs text-gray-600 mb-2">
                  No Google or Apple required — a 24-word recovery phrase secures your vault. Lose it = lose your data.
                </p>
                <p className="text-xs text-primary-600 group-hover:underline">
                  Create or restore a passphrase vault →
                </p>
              </div>
            </div>
          </Link>
          )}

          {/* Mode A — Maximum Ease (inline Google + Apple buttons) */}
          {showModeA && (
          <div className="rounded-xl border border-gray-200 p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="flex-shrink-0 text-2xl">👤</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-semibold text-gray-900">Maximum Ease</h3>
                  <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-blue-100 text-blue-700">
                    Easiest
                  </span>
                </div>
                <p className="text-xs text-gray-600">
                  Sign in with Google or Apple. Your encryption is tied to your account.
                </p>
              </div>
            </div>
            <div className="flex flex-col items-center gap-3 pt-1">
              {(!platformParam || platformParam === 'google') && (
                <div id="google-signin-button"></div>
              )}
              {(!platformParam || platformParam === 'apple') && (
                <button
                  onClick={handleAppleSignIn}
                  className="flex items-center justify-center gap-3 w-[280px] h-[44px] bg-black text-white rounded-md hover:bg-gray-800 transition-colors font-medium text-sm"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
                  </svg>
                  Sign in with Apple
                </button>
              )}
            </div>
          </div>
          )}

          {/* When the app pinned a specific mode (e.g. modeParam='b'),
              tell the user why the other two are missing — they can
              still pick a different mode from inside the FxFiles app. */}
          {modeParam ? (
            <p className="text-[11px] text-gray-500 text-center italic pt-2">
              Only your selected vault mode is shown here. To switch modes,
              go back to the FxFiles app.
            </p>
          ) : (
            <p className="text-[11px] text-gray-500 text-center italic pt-2">
              You can't switch modes later without re-uploading your files — each mode is a separate vault.
            </p>
          )}

          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-500 text-center">
              {t.login.terms}
            </p>
          </div>
        </div>

        {/* Features */}
        <div className="mt-8 grid grid-cols-3 gap-4 text-center">
          <div className="p-4">
            <div className="text-2xl mb-2">🔑</div>
            <div className="text-sm font-medium text-gray-900">{t.login.apiKeys}</div>
            <div className="text-xs text-gray-500">{t.login.apiKeysDesc}</div>
          </div>
          <div className="p-4">
            <div className="text-2xl mb-2">📌</div>
            <div className="text-sm font-medium text-gray-900">{t.login.pinCids}</div>
            <div className="text-xs text-gray-500">{t.login.pinCidsDesc}</div>
          </div>
          <div className="p-4">
            <div className="text-2xl mb-2">📊</div>
            <div className="text-sm font-medium text-gray-900">{t.login.analytics}</div>
            <div className="text-xs text-gray-500">{t.login.analyticsDesc}</div>
          </div>
        </div>

        {/* Pricing info */}
        <div className="mt-6 bg-white/60 backdrop-blur rounded-xl p-4 text-center">
          <div className="flex items-center justify-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-green-500">✓</span>
              <span className="text-gray-700">{pricing?.freeTierMB || 500} MB Free</span>
            </div>
            <div className="h-4 w-px bg-gray-300"></div>
            <div className="flex items-center gap-2">
              <span className="text-primary-600 font-medium">{pricing?.fulaPerGBMonth || 3} FULA</span>
              <span className="text-gray-500">/ GB / month</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
