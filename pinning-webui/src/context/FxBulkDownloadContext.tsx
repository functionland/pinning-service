/**
 * Shared state for the FxFiles "Download All" feature.
 *
 * The bulk download is a long-running operation that the user can trigger from
 * either the /pins → FxFiles tab or the /profile page. Without a shared store,
 * navigating away from the page that started it would lose the progress UI and
 * orphan the AbortController. Lifting state to a context that lives at the
 * Layout level means progress and cancellation work regardless of which
 * authenticated page is currently mounted.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from './AuthContext';
import { deriveEncryptionKeyBytes } from '../services/encryptionService';
import { getFulaClient, listFulaBuckets } from '../services/fulaClientService';
import {
  downloadAllFxFiles,
  type BulkProgress,
  type FxBucketSummary,
} from '../services/fxFilesBulkDownload';

interface FxBulkDownloadContextValue {
  progress: BulkProgress | null;
  isRunning: boolean;
  /**
   * Start a bulk download. If `buckets` is omitted the hook will fetch the
   * full bucket list itself — useful when the caller (e.g. the Profile page)
   * doesn't already have it loaded.
   */
  start: (opts?: { buckets?: FxBucketSummary[] }) => Promise<void>;
  cancel: () => void;
  dismiss: () => void;
}

const FxBulkDownloadContext = createContext<FxBulkDownloadContextValue | null>(null);

const FULA_GATEWAY_ENDPOINT = 'https://s3.cloud.fx.land';

function makeErrorProgress(error: string): BulkProgress {
  return {
    phase: 'error',
    bucketsTotal: 0,
    bucketsDone: 0,
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    failures: [{ bucket: '<init>', key: '', error }],
    bufferingFallback: false,
  };
}

export function FxBulkDownloadProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const aborterRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const start = useCallback(
    async (opts?: { buckets?: FxBucketSummary[] }) => {
      if (!user?.id || !user?.email) return;
      if (runningRef.current) return;
      runningRef.current = true;

      try {
        const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
        if (!tokenRes.ok) {
          setProgress(makeErrorProgress('API key required'));
          return;
        }
        const { key: apiToken } = await tokenRes.json();

        let buckets = opts?.buckets;
        if (!buckets) {
          const keyBytes = await deriveEncryptionKeyBytes(
            user.provider,
            user.id,
            user.email,
          );
          const client = await getFulaClient(keyBytes, apiToken, FULA_GATEWAY_ENDPOINT);
          const rawBuckets = await listFulaBuckets(client);
          buckets = (rawBuckets || []).map((b: any) => ({
            name: b.name || b.Name,
            creationDate: b.creationDate || b.CreationDate,
          }));
        }

        if (!buckets || buckets.length === 0) {
          setProgress(makeErrorProgress('No files to download.'));
          return;
        }

        const aborter = new AbortController();
        aborterRef.current = aborter;

        await downloadAllFxFiles({
          buckets,
          user: { id: user.id, email: user.email, provider: user.provider },
          apiToken,
          signal: aborter.signal,
          onProgress: setProgress,
        });
      } catch (err) {
        console.error('[FxBulk] download failed:', err);
        const message = err instanceof Error ? err.message : String(err);
        setProgress((prev) =>
          prev
            ? { ...prev, phase: 'error' }
            : makeErrorProgress(message),
        );
      } finally {
        runningRef.current = false;
        aborterRef.current = null;
      }
    },
    [user?.id, user?.email, user?.provider],
  );

  const cancel = useCallback(() => {
    aborterRef.current?.abort();
  }, []);

  const dismiss = useCallback(() => {
    setProgress(null);
  }, []);

  const isRunning =
    progress?.phase === 'listing' ||
    progress?.phase === 'downloading' ||
    progress?.phase === 'finalizing';

  return (
    <FxBulkDownloadContext.Provider
      value={{ progress, isRunning, start, cancel, dismiss }}
    >
      {children}
    </FxBulkDownloadContext.Provider>
  );
}

export function useFxBulkDownload(): FxBulkDownloadContextValue {
  const ctx = useContext(FxBulkDownloadContext);
  if (!ctx) {
    throw new Error('useFxBulkDownload must be used within FxBulkDownloadProvider');
  }
  return ctx;
}
