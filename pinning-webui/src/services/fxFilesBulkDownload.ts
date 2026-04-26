/**
 * Bulk "Download All" orchestrator for the FxFiles tab.
 *
 * Enumerates every file across every bucket, decrypts each one with bounded
 * concurrency, streams the result into a ZIP via `client-zip`, and saves it
 * either through the File System Access API (Chromium: zero-buffer streaming
 * to disk) or as a Blob download (Firefox/Safari fallback).
 *
 * The encryption path reuses the same primitives as the per-row download
 * (`getFulaClient`, `listDecryptedFiles`, `decryptFxFile`).
 */

import { downloadZip } from 'client-zip';

import {
  deriveEncryptionKeyBytes,
  decryptFxFile,
  downloadBlob,
  type AuthProvider,
} from './encryptionService';
import {
  getFulaClient,
  listDecryptedFiles,
} from './fulaClientService';

const FULA_GATEWAY_ENDPOINT = 'https://s3.cloud.fx.land';
// Conservative default: the @functionland/fula-client WASM module shares
// per-process state (cached client, in-memory forest) — running multiple
// decryptions in parallel could corrupt that state. Stick to 1 until a
// concurrent round-trip test proves higher values are safe.
const DEFAULT_CONCURRENCY = 1;

export interface FxBucketSummary {
  name: string;
  creationDate?: string;
}

export interface BulkDownloadFailure {
  bucket: string;
  key: string;
  error: string;
}

export type BulkPhase =
  | 'idle'
  | 'listing'
  | 'downloading'
  | 'finalizing'
  | 'done'
  | 'aborted'
  | 'error';

export interface BulkProgress {
  phase: BulkPhase;
  bucketsTotal: number;
  bucketsDone: number;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  currentFile?: string;
  failures: BulkDownloadFailure[];
  /** True when the save path will buffer the whole ZIP in memory (no FSA). */
  bufferingFallback: boolean;
}

export interface BulkDownloadOptions {
  buckets: FxBucketSummary[];
  user: { id: string; email: string; provider: AuthProvider };
  apiToken: string;
  onProgress: (p: BulkProgress) => void;
  signal: AbortSignal;
  zipFilename?: string;
  endpoint?: string;
  concurrency?: number;
}

interface PlannedFile {
  bucket: string;
  storageKey: string;
  originalKey: string;
  size: number;
  lastModified?: Date;
}

interface ZipEntry {
  name: string;
  input: Uint8Array;
  lastModified?: Date;
}

class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError();
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function pickFulaField<T = any>(file: any, ...names: string[]): T | undefined {
  for (const n of names) {
    if (file && file[n] !== undefined && file[n] !== null) return file[n] as T;
  }
  return undefined;
}

/**
 * Apply the same skip rules used by the file browser
 * (Pins.tsx navigateToFxDirectory) so we never try to decrypt internal blobs.
 */
function shouldSkipListEntry(file: any): boolean {
  const originalKey = pickFulaField<string>(file, 'originalKey') || '';
  const storageKey = pickFulaField<string>(file, 'storageKey', 'key', 'Key') || '';
  const key = originalKey || storageKey;

  if (!key) return true;
  if (key.includes('.chunks')) return true;
  if (storageKey.startsWith('__fula_') || key.startsWith('__fula_')) return true;

  // Internal/unresolved files: storageKey is a CID and metadata didn't decrypt.
  const isInternalFile =
    storageKey.startsWith('Qm') &&
    (file.originalKey === storageKey || !file.originalKey || file.originalKey.startsWith('Qm'));
  if (isInternalFile && !file.isEncrypted) return true;

  return false;
}

function toPlannedFile(file: any, bucket: string): PlannedFile | null {
  if (shouldSkipListEntry(file)) return null;

  const storageKey = pickFulaField<string>(file, 'storageKey', 'key', 'Key') || '';
  const originalKey = pickFulaField<string>(file, 'originalKey') || storageKey;
  if (!storageKey) return null;

  const sizeRaw = pickFulaField<number | string>(file, 'size', 'Size') ?? 0;
  const size = typeof sizeRaw === 'string' ? Number(sizeRaw) || 0 : sizeRaw;

  const lastModifiedRaw = pickFulaField<string | number | Date>(
    file,
    'lastModified',
    'LastModified',
  );
  let lastModified: Date | undefined;
  if (lastModifiedRaw) {
    const d = new Date(lastModifiedRaw as any);
    if (!isNaN(d.getTime())) lastModified = d;
  }

  return { bucket, storageKey, originalKey, size, lastModified };
}

function sanitizeZipPath(s: string): string {
  // Normalize slashes, strip leading slashes, collapse repeats, drop empty segs.
  return s
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function buildZipEntryName(bucket: string, originalKey: string): string {
  return `${sanitizeZipPath(bucket)}/${sanitizeZipPath(originalKey)}`;
}

/**
 * A simple async queue: producers push entries, the iterable yields them.
 * Used to feed `client-zip` while decrypt tasks are still running.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (v: IteratorResult<T>) => void;
    reject: (e: any) => void;
  }> = [];
  private closed = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()!.resolve({ value: undefined as any, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    while (this.waiters.length) {
      this.waiters.shift()!.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.error) return Promise.reject(this.error);
        if (this.items.length) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/**
 * Run worker tasks with at most `limit` in flight.
 */
async function runBoundedPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const inflight = new Set<Promise<void>>();

  const launch = (item: T, idx: number) => {
    const promise = (async () => {
      await worker(item, idx);
    })();
    inflight.add(promise);
    // Cleanup on both fulfillment and rejection. Rejection is also observed by
    // Promise.race below, but attaching a handler here avoids unhandled-rejection
    // warnings when the worker throws (e.g., AbortError).
    const remove = () => {
      inflight.delete(promise);
    };
    promise.then(remove, remove);
  };

  while (cursor < items.length) {
    throwIfAborted(signal);
    while (inflight.size < limit && cursor < items.length) {
      launch(items[cursor], cursor);
      cursor++;
    }
    if (inflight.size > 0) {
      await Promise.race(inflight);
    }
  }
  await Promise.all(inflight);
}

function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).showSaveFilePicker === 'function'
  );
}

/**
 * Public entry point.
 */
export async function downloadAllFxFiles(opts: BulkDownloadOptions): Promise<void> {
  const {
    buckets,
    user,
    apiToken,
    onProgress,
    signal,
    zipFilename = `fxfiles-${todayStamp()}.zip`,
    endpoint = FULA_GATEWAY_ENDPOINT,
    concurrency = DEFAULT_CONCURRENCY,
  } = opts;

  const bufferingFallback = !isFileSystemAccessSupported();

  const progress: BulkProgress = {
    phase: 'listing',
    bucketsTotal: buckets.length,
    bucketsDone: 0,
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    failures: [],
    bufferingFallback,
  };
  const emit = (patch: Partial<BulkProgress>) => {
    Object.assign(progress, patch);
    onProgress({ ...progress, failures: [...progress.failures] });
  };
  emit({});

  if (buckets.length === 0) {
    emit({ phase: 'done' });
    return;
  }

  // 0) If FSA is supported, prompt the user for a save location FIRST while
  //    the click's transient user activation is still valid. Listing buckets
  //    can take many seconds (HEAD-per-object) and would otherwise let the
  //    activation expire, causing showSaveFilePicker to throw SecurityError.
  let saveHandle: any = null;
  if (isFileSystemAccessSupported()) {
    try {
      saveHandle = await (window as any).showSaveFilePicker({
        suggestedName: zipFilename,
        types: [
          {
            description: 'ZIP archive',
            accept: { 'application/zip': ['.zip'] },
          },
        ],
      });
    } catch (err: any) {
      if (err && (err.name === 'AbortError' || err.code === 20)) {
        emit({ phase: 'aborted' });
        return;
      }
      throw err;
    }
  }

  // 1) Init crypto + client once.
  throwIfAborted(signal);
  const keyBytes = await deriveEncryptionKeyBytes(user.provider, user.id, user.email);
  throwIfAborted(signal);
  const client = await getFulaClient(keyBytes, apiToken, endpoint);

  // 2) Listing phase — one listDecryptedFiles call per bucket gives every file
  //    at every depth (FlatNamespace mode).
  const planned: PlannedFile[] = [];
  for (const bucket of buckets) {
    throwIfAborted(signal);
    try {
      const files = await listDecryptedFiles(client, bucket.name, {});
      for (const f of files || []) {
        const pf = toPlannedFile(f, bucket.name);
        if (pf) planned.push(pf);
      }
    } catch (err) {
      progress.failures.push({
        bucket: bucket.name,
        key: '<list>',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    emit({ bucketsDone: progress.bucketsDone + 1 });
  }

  if (planned.length === 0) {
    if (progress.failures.length === 0) {
      emit({ phase: 'done' });
      return;
    }
    // Still emit a ZIP containing only _failures.txt so the user gets a record.
  }

  emit({
    phase: 'downloading',
    filesTotal: planned.length,
    bytesTotal: planned.reduce((sum, p) => sum + (p.size || 0), 0),
  });

  // 3) Spin up the ZIP stream as soon as we have files queued; entries are
  //    pushed to `queue` as decrypts complete. The pool runs concurrently
  //    with `downloadZip` consuming the iterable.
  const queue = new AsyncQueue<ZipEntry>();

  const onAbort = () => queue.fail(new AbortError());
  signal.addEventListener('abort', onAbort, { once: true });

  const zipResponse = downloadZip(queue, {
    metadata: planned.map((p) => ({
      name: buildZipEntryName(p.bucket, p.originalKey),
      size: p.size,
      lastModified: p.lastModified,
    })),
  });
  const zipStream = zipResponse.body as ReadableStream<Uint8Array> | null;
  if (!zipStream) {
    signal.removeEventListener('abort', onAbort);
    throw new Error('Failed to create ZIP stream (no response body)');
  }

  // Producer: bounded-concurrency decrypt → push to queue.
  const producer = (async () => {
    try {
      await runBoundedPool(
        planned,
        Math.max(1, concurrency),
        async (file) => {
          throwIfAborted(signal);
          emit({ currentFile: `${file.bucket}/${file.originalKey}` });
          try {
            const bytes = await decryptFxFile(
              client,
              file.bucket,
              file.storageKey,
              keyBytes,
            );
            queue.push({
              name: buildZipEntryName(file.bucket, file.originalKey),
              input: bytes,
              lastModified: file.lastModified,
            });
            emit({
              filesDone: progress.filesDone + 1,
              bytesDone: progress.bytesDone + bytes.byteLength,
            });
          } catch (err) {
            progress.failures.push({
              bucket: file.bucket,
              key: file.originalKey,
              error: err instanceof Error ? err.message : String(err),
            });
            emit({ filesDone: progress.filesDone + 1 });
          }
        },
        signal,
      );

      // Append a failures manifest if anything went wrong, so the user has
      // a record of which files were skipped.
      if (progress.failures.length > 0) {
        const lines = [
          `FxFiles "Download All" — ${progress.failures.length} failure(s)`,
          `Generated: ${new Date().toISOString()}`,
          '',
          ...progress.failures.map((f) => `${f.bucket}/${f.key}\t${f.error}`),
        ];
        queue.push({
          name: '_failures.txt',
          input: new TextEncoder().encode(lines.join('\n')),
          lastModified: new Date(),
        });
      }

      queue.close();
    } catch (err) {
      queue.fail(err);
    }
  })();

  // 4) Save phase — stream-to-disk if we obtained a handle earlier,
  //    otherwise buffer to a Blob and use the existing anchor download.
  emit({ phase: 'finalizing' });
  try {
    if (saveHandle) {
      const writable = await saveHandle.createWritable();
      try {
        await zipStream.pipeTo(writable, { signal });
      } catch (err) {
        try {
          await writable.abort();
        } catch {
          /* ignore */
        }
        throw err;
      }
      await producer;
    } else {
      const blob = await zipResponse.blob();
      await producer;
      downloadBlob(
        new Uint8Array(await blob.arrayBuffer()),
        zipFilename,
        'application/zip',
      );
    }

    emit({ phase: 'done', currentFile: undefined });
  } catch (err) {
    if (err instanceof AbortError || (err as any)?.name === 'AbortError') {
      emit({ phase: 'aborted' });
      return;
    }
    progress.failures.push({
      bucket: '<archive>',
      key: zipFilename,
      error: err instanceof Error ? err.message : String(err),
    });
    emit({ phase: 'error' });
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
