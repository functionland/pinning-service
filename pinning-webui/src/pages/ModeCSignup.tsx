/**
 * Mode C (passphrase-only) sign-in / sign-up screen for pinning-webui.
 *
 * Mirrors the FxFiles `mode_c_signin_screen.dart` pattern:
 *   - Top-level chooser: create a new vault OR restore an existing one.
 *   - Create flow: generate 24-word BIP39 mnemonic → display with strong
 *     "write it down, we can never show it again" warning → 3-of-24
 *     partial verification → register with the issuer.
 *   - Restore flow: user pastes mnemonic → local checksum check →
 *     register with the issuer (idempotent — returning users land on the
 *     same vault).
 *
 * "Seed IS the user." Anyone who knows the mnemonic IS this user.
 * There's no password reset and no recovery via OAuth.
 *
 * The mnemonic is the seed passed straight to
 * `AuthContext.loginWithModeC` — which runs it through NFC normalize +
 * BLAKE3 derive_key (Mode C effective_user_id) and the Ed25519 signing
 * keypair derivation, exactly as FxFiles does. Two callers with the
 * same mnemonic reach the same vault on the issuer.
 */

import { generateMnemonic, validateMnemonic } from 'bip39';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../context/AuthContext';

/**
 * Resolve the post-signin navigation target. When the /get-key → /login
 * bounce forwarded a `returnTo` URL param, return there so /get-key can
 * fetch the API key and trigger the fxfiles://auth-callback handoff.
 * Otherwise land on the dashboard.
 */
function useSuccessDestination(): string {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('returnTo');
  return returnTo && returnTo.startsWith('/') ? returnTo : '/';
}

type Subflow = 'choose' | 'create' | 'restore';

export default function ModeCSignup() {
  const [subflow, setSubflow] = useState<Subflow>('choose');

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-gray-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="bg-white rounded-2xl shadow-lg p-8">
          {subflow === 'choose' && (
            <ChoosePanel
              onCreate={() => setSubflow('create')}
              onRestore={() => setSubflow('restore')}
            />
          )}
          {subflow === 'create' && (
            <CreateFlow onBack={() => setSubflow('choose')} />
          )}
          {subflow === 'restore' && (
            <RestorePanel onBack={() => setSubflow('choose')} />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Chooser: create vs restore
// ============================================================================

function ChoosePanel({
  onCreate,
  onRestore,
}: {
  onCreate: () => void;
  onRestore: () => void;
}) {
  return (
    <>
      <div className="text-center mb-6">
        <div className="text-4xl mb-2">🔐</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Passphrase-only vault
        </h1>
        <p className="text-sm text-gray-600">
          No Google or Apple account — the only thing tying you to your files
          is a 24-word recovery phrase.
        </p>
      </div>

      <div className="space-y-3">
        <button
          onClick={onCreate}
          className="w-full px-4 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-md font-medium text-sm"
        >
          Create new vault
        </button>
        <button
          onClick={onRestore}
          className="w-full px-4 py-3 bg-white border border-gray-300 hover:border-primary-500 text-gray-800 rounded-md font-medium text-sm"
        >
          Restore from recovery phrase
        </button>
      </div>

      <div className="mt-6 p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
        <div className="text-red-600 text-lg leading-none">⚠️</div>
        <p className="text-xs text-red-700">
          There is no "Forgot password". If you lose your recovery phrase,
          your files are gone forever — we cannot reset it.
        </p>
      </div>

      <div className="mt-6 pt-4 border-t border-gray-100 text-center">
        <Link to="/login" className="text-xs text-gray-500 hover:text-gray-700">
          ← Back to mode selection
        </Link>
      </div>
    </>
  );
}

// ============================================================================
// Create new vault — multi-step wizard
// ============================================================================

type CreateStep = 'display' | 'verify' | 'register';

function CreateFlow({ onBack }: { onBack: () => void }) {
  const { loginWithModeC } = useAuth();
  const navigate = useNavigate();
  const successDestination = useSuccessDestination();

  // 256 bits of entropy → 24-word English BIP39 mnemonic.
  // Generated once on mount; never regenerated within this CreateFlow
  // lifetime so the user verifies the same words they were shown.
  const mnemonic = useMemo(() => generateMnemonic(256), []);
  const words = useMemo(() => mnemonic.split(/\s+/), [mnemonic]);

  // Pick 3 distinct random positions to verify (sorted ascending). The
  // positions are stable within this flow's lifetime.
  const verifyIndices = useMemo(() => {
    const positions = words.map((_, i) => i);
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    return positions.slice(0, 3).sort((a, b) => a - b);
  }, [words]);

  const [step, setStep] = useState<CreateStep>('display');
  const [verifyValues, setVerifyValues] = useState<[string, string, string]>([
    '',
    '',
    '',
  ]);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const doRegister = async () => {
    setRegistering(true);
    setRegisterError(null);
    try {
      await loginWithModeC(mnemonic);
      navigate(successDestination, { replace: true });
    } catch (e) {
      const err = e as Error & { code?: string };
      setRegistering(false);
      setRegisterError(humanizeError(err));
    }
  };

  const checkVerification = () => {
    for (let i = 0; i < 3; i++) {
      const expected = words[verifyIndices[i]].trim().toLowerCase();
      const got = verifyValues[i].trim().toLowerCase();
      if (got !== expected) {
        setVerifyError(
          `Word ${verifyIndices[i] + 1} doesn't match. Re-check your recorded phrase.`,
        );
        return;
      }
    }
    setVerifyError(null);
    setStep('register');
    void doRegister();
  };

  if (step === 'display') {
    return (
      <>
        <div className="mb-4 p-3 bg-red-50 border border-red-300 rounded-md flex items-start gap-2">
          <div className="text-red-600 text-lg leading-none">⚠️</div>
          <p className="text-sm text-red-700 font-semibold">
            Write these 24 words down on paper IN ORDER. Anyone who has them
            has your files. We cannot show them to you again.
          </p>
        </div>

        <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-sm">
            {words.map((w, i) => (
              <div key={i} className="flex items-baseline gap-2">
                <span className="text-gray-400 text-xs w-6 shrink-0 text-right">
                  {i + 1}.
                </span>
                <span className="text-gray-900">{w}</span>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={() => setStep('verify')}
          className="w-full px-4 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-md font-medium text-sm"
        >
          I've saved it — verify
        </button>
        <button
          onClick={onBack}
          className="w-full mt-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
      </>
    );
  }

  if (step === 'verify') {
    return (
      <>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          Verify your phrase
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          Type 3 of the 24 words from your recovery phrase. This proves you
          actually wrote it down.
        </p>

        <div className="space-y-3 mb-4">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Word #{verifyIndices[i] + 1}
              </label>
              <input
                type="text"
                value={verifyValues[i]}
                onChange={(e) => {
                  const next = [...verifyValues] as [string, string, string];
                  next[i] = e.target.value;
                  setVerifyValues(next);
                }}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={registering}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm font-mono"
              />
            </div>
          ))}
        </div>

        {verifyError && (
          <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
            {verifyError}
          </div>
        )}

        <button
          onClick={checkVerification}
          disabled={registering}
          className="w-full px-4 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-md font-medium text-sm disabled:opacity-50"
        >
          Continue
        </button>
        <button
          onClick={() => {
            setVerifyError(null);
            setStep('display');
          }}
          disabled={registering}
          className="w-full mt-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-700"
        >
          Back — show phrase again
        </button>
      </>
    );
  }

  // step === 'register'
  return (
    <div className="py-8">
      {registerError === null ? (
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600 mb-4" />
          <p className="text-sm text-gray-700">Creating your vault…</p>
        </div>
      ) : (
        <>
          <div className="text-center mb-4">
            <div className="text-4xl mb-2">❌</div>
            <h2 className="text-lg font-bold text-red-700">
              Registration failed
            </h2>
          </div>
          <p className="text-sm text-red-700 text-center mb-6">
            {registerError}
          </p>
          <button
            onClick={() => {
              setStep('verify');
              setRegisterError(null);
            }}
            className="w-full px-4 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-md font-medium text-sm"
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Restore from existing mnemonic
// ============================================================================

function RestorePanel({ onBack }: { onBack: () => void }) {
  const { loginWithModeC } = useAuth();
  const navigate = useNavigate();
  const successDestination = useSuccessDestination();
  const [mnemonic, setMnemonic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const doRestore = async () => {
    const phrase = mnemonic.trim().replace(/\s+/g, ' ');
    if (!phrase) {
      setError('Enter your recovery phrase.');
      return;
    }
    if (!validateMnemonic(phrase)) {
      setError(
        "That doesn't look like a valid 12 / 18 / 24-word BIP39 phrase. Check for typos.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await loginWithModeC(phrase);
      navigate(successDestination, { replace: true });
    } catch (e) {
      const err = e as Error & { code?: string };
      setBusy(false);
      setError(humanizeError(err));
    }
  };

  return (
    <>
      <div className="text-center mb-6">
        <div className="text-4xl mb-2">🔑</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Restore your vault
        </h1>
        <p className="text-sm text-gray-600">
          Type your 24-word recovery phrase, separated by spaces. Order matters.
        </p>
      </div>

      <textarea
        ref={textareaRef}
        value={mnemonic}
        onChange={(e) => setMnemonic(e.target.value)}
        disabled={busy}
        rows={4}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="word1 word2 word3 …"
        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm font-mono"
      />

      {error && (
        <div className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <button
        onClick={doRestore}
        disabled={busy}
        className="w-full mt-4 px-4 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-md font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy && (
          <span className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
        )}
        {busy ? 'Restoring…' : 'Restore vault'}
      </button>

      <button
        onClick={onBack}
        disabled={busy}
        className="w-full mt-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-700"
      >
        Back
      </button>
    </>
  );
}

// ============================================================================
// Error formatting
// ============================================================================

function humanizeError(err: Error & { code?: string }): string {
  switch (err.code) {
    case 'PUBLIC_KEY_MISMATCH':
      return "A vault exists for this phrase with a different key. This shouldn't happen for a passphrase-only vault.";
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
