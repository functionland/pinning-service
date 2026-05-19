import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { clearAllKeys } from '../services/secureStorage';
import {
  buildModeBRegistrationProof,
  buildModeCRegistrationProof,
  bytesToBase64,
  base64ToBytes,
} from '../services/seedAuthCrypto';

interface User {
  // Mode A/B: OAuth sub; Mode C: effective_user_id_hex (same as userId).
  id: string;
  // Mode A: SHA-256(email); Mode B/C: effective_user_id_hex (32 hex chars).
  userId: string;
  email: string;
  name: string;
  picture: string;
  // 'seed' = Mode C (passphrase-only). Mode A/B keep 'google' / 'apple'.
  provider: 'google' | 'apple' | 'seed';
}

// Apple user info sent on first sign-in
interface AppleUserInfo {
  email?: string;
  name?: {
    firstName?: string;
    lastName?: string;
  };
}

// Mode B sign-in / sign-up arguments. Server endpoint is idempotent on
// `effective_user_id` → same OAuth + same password reaches the same
// vault, so returning users go through the same path as new users.
interface ModeBLoginArgs {
  provider: 'google' | 'apple';
  oauthToken: string;
  appleUser?: AppleUserInfo;
  password: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (credential: string, referralCode?: string) => Promise<{ isNew: boolean }>;
  loginWithApple: (identityToken: string, appleUser?: AppleUserInfo, referralCode?: string) => Promise<{ isNew: boolean }>;
  loginWithModeB: (args: ModeBLoginArgs) => Promise<{ isNew: boolean; hasModeA: boolean }>;
  loginWithModeC: (seed: string) => Promise<{ isNew: boolean }>;
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

  // ----- Mode B / Mode C helpers --------------------------------------
  // Both flows: client computes `effective_user_id` locally → fetches a
  // server-issued single-use challenge → signs a domain-tagged transcript
  // with the seed-derived Ed25519 key → POSTs registration proof.
  //
  // Server responds with `user` (already populated in req.session.user
  // server-side, see app.ts:register-mode-{b,c}). We set it directly to
  // skip a follow-up `/auth/me` roundtrip. The session cookie is set on
  // the same response.

  // Decode a JWT's payload claims without verifying the signature.
  // Used for OAuth ID tokens — we send the raw token to the server for
  // verification but need the `sub` locally to compute the
  // `effective_user_id` and derive the Mode B signing keypair.
  const decodeJwtPayload = (token: string): { sub?: string; email?: string } => {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    try {
      const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
      const json = atob(padded);
      return JSON.parse(json) as { sub?: string; email?: string };
    } catch {
      return {};
    }
  };

  const fetchChallenge = async (
    effectiveUserIdHex: string,
    purpose: 'register-mode-b' | 'register-mode-c' | 'sign-in',
  ): Promise<Uint8Array> => {
    const res = await fetch('/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        effective_user_id_hex: effectiveUserIdHex,
        purpose,
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Challenge request failed (${res.status})`);
    }
    const data = await res.json();
    return base64ToBytes(data.challenge_b64);
  };

  const loginWithModeB = async (args: ModeBLoginArgs): Promise<{ isNew: boolean; hasModeA: boolean }> => {
    const { provider, oauthToken, password } = args;
    if (!password) throw new Error('Mode B password must not be empty');

    // Pull the OAuth `sub` from the token client-side — needed to derive
    // both the effective_user_id and the OAuth-bound signing keypair.
    // The server independently verifies the same token, so a spoofed
    // client-side `sub` would fail at registration.
    const payload = decodeJwtPayload(oauthToken);
    const oauthSub = payload.sub;
    if (!oauthSub) throw new Error('OAuth token did not contain a sub claim');

    const effectiveUserIdHex = await (await import('../services/seedAuthCrypto'))
      .computeEffectiveUserIdModeB(provider, oauthSub, password);

    const challenge = await fetchChallenge(effectiveUserIdHex, 'register-mode-b');
    const proof = await buildModeBRegistrationProof({
      provider,
      oauthSub,
      password,
      challenge,
    });

    const res = await fetch('/auth/register-mode-b', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        provider,
        oauth_token: oauthToken,
        // Apple sends the displayed name only on first sign-in via a
        // sidecar object — forward it so the server can populate the
        // session user record. Mode B mirrors the Mode A Apple flow.
        ...(provider === 'apple' && args.appleUser ? { user: args.appleUser } : {}),
        effective_user_id_hex: proof.effectiveUserIdHex,
        public_key_b64: bytesToBase64(proof.publicKey),
        challenge_b64: bytesToBase64(challenge),
        signature_b64: bytesToBase64(proof.signature),
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const err = new Error(errData.error || `Mode B registration failed (${res.status})`);
      (err as Error & { code?: string }).code = errData.code;
      throw err;
    }
    const data = await res.json();
    setUser(data.user);
    return { isNew: data.created ?? false, hasModeA: data.has_mode_a ?? false };
  };

  const loginWithModeC = async (seed: string): Promise<{ isNew: boolean }> => {
    if (!seed.trim()) throw new Error('Mode C seed must not be empty');
    const effectiveUserIdHex = await (await import('../services/seedAuthCrypto'))
      .computeEffectiveUserIdModeC(seed);

    const challenge = await fetchChallenge(effectiveUserIdHex, 'register-mode-c');
    const proof = await buildModeCRegistrationProof({ seed, challenge });

    const res = await fetch('/auth/register-mode-c', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        effective_user_id_hex: proof.effectiveUserIdHex,
        public_key_b64: bytesToBase64(proof.publicKey),
        challenge_b64: bytesToBase64(challenge),
        signature_b64: bytesToBase64(proof.signature),
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const err = new Error(errData.error || `Mode C registration failed (${res.status})`);
      (err as Error & { code?: string }).code = errData.code;
      throw err;
    }
    const data = await res.json();
    setUser(data.user);
    return { isNew: data.created ?? false };
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
    <AuthContext.Provider
      value={{ user, loading, login, loginWithApple, loginWithModeB, loginWithModeC, logout }}
    >
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
