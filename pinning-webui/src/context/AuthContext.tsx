import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { clearAllKeys } from '../services/secureStorage';

interface User {
  id: string; // User ID for encryption key derivation (Google sub or Apple sub)
  email: string;
  name: string;
  picture: string;
  provider: 'google' | 'apple'; // Authentication provider
}

// Apple user info sent on first sign-in
interface AppleUserInfo {
  email?: string;
  name?: {
    firstName?: string;
    lastName?: string;
  };
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (credential: string, referralCode?: string) => Promise<{ isNew: boolean }>;
  loginWithApple: (identityToken: string, appleUser?: AppleUserInfo, referralCode?: string) => Promise<{ isNew: boolean }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        // Backward compatibility: default to 'google' if provider not set
        setUser({
          ...data.user,
          provider: data.user.provider || 'google',
        });
      }
    } catch (error) {
      console.error('Auth check failed:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (credential: string, referralCode?: string) => {
    const res = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ credential, referralCode }),
    });

    if (!res.ok) {
      throw new Error('Login failed');
    }

    const data = await res.json();
    // Ensure provider is set (should be 'google' from server)
    setUser({
      ...data.user,
      provider: data.user.provider || 'google',
    });
    return { isNew: data.isNew };
  };

  const loginWithApple = async (identityToken: string, appleUser?: AppleUserInfo, referralCode?: string) => {
    const res = await fetch('/auth/apple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ identityToken, user: appleUser, referralCode }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'Apple login failed');
    }

    const data = await res.json();
    setUser({
      ...data.user,
      provider: data.user.provider || 'apple',
    });
    return { isNew: data.isNew };
  };

  const logout = async () => {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
    // Clear encryption keys from secure storage
    try {
      await clearAllKeys();
    } catch (e) {
      console.error('Failed to clear secure storage:', e);
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, loginWithApple, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
