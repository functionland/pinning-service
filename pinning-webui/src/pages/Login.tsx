import { useEffect, useCallback, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
  }
}

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [totalSize, setTotalSize] = useState(0);
  const animatedSize = useAnimatedCounter(totalSize, 5000);
  const formattedSize = formatStorageSize(animatedSize);

  // Fetch public stats on mount
  useEffect(() => {
    fetch('/api/public/stats')
      .then(res => res.json())
      .then(data => {
        if (data.totalSize) {
          setTotalSize(data.totalSize);
        }
      })
      .catch(err => console.error('Failed to fetch stats:', err));
  }, []);

  const handleCredentialResponse = useCallback(async (response: { credential: string }) => {
    console.log('[Login] Google credential received, length:', response.credential?.length);
    try {
      const result = await login(response.credential);
      console.log('[Login] Login successful, isNew:', result.isNew);
      if (result.isNew) {
        navigate('/?welcome=true');
      } else {
        navigate('/');
      }
    } catch (error) {
      console.error('[Login] Login failed:', error);
      alert('Login failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }, [login, navigate]);

  useEffect(() => {
    if (user) {
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

    // Wait for Google script to load
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
  }, [user, navigate, handleCredentialResponse]);

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
        {totalSize > 0 && (
          <div className="bg-white/80 backdrop-blur rounded-xl shadow-sm p-6 mb-6 text-center">
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

        {/* Login card */}
        <div className="bg-white rounded-2xl shadow-lg p-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-6 text-center">
            {t.login.signIn}
          </h2>

          <div className="flex justify-center">
            <div id="google-signin-button"></div>
          </div>

          <div className="mt-6 pt-6 border-t border-gray-100">
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
      </div>
    </div>
  );
}
