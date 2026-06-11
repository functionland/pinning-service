import { useCallback, useRef, useState } from 'react';
import { CarBlockIterator } from '@ipld/car';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { deriveEncryptionKey, encrypt } from '../services/encryptionService';

interface ImportDagModalProps {
  open: boolean;
  maxCarBytes: number;
  onClose: () => void;
  /** Called after the server accepted the CAR (pin created) — parent should
   *  close the modal and refresh the pins list. */
  onImported: () => void;
}

type Phase = 'idle' | 'uploading' | 'importing';

interface Preflight {
  rootCid: string | null;
  warning: boolean; // header unreadable client-side; server stays authoritative
}

// Read ONLY the CAR header (first 1 MiB slice) to show the root CID before
// uploading. CarBlockIterator decodes the header eagerly and blocks lazily,
// so the truncated slice is never a problem as long as we don't iterate.
async function preflightCarHeader(file: File): Promise<string[]> {
  const head = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
  async function* once() {
    yield head;
  }
  const iter = await CarBlockIterator.fromIterable(once());
  const roots = await iter.getRoots();
  return roots.map((r) => r.toString());
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function ImportDagModal({ open, maxCarBytes, onClose, onImported }: ImportDagModalProps) {
  const { t } = useLanguage();
  const { user } = useAuth();

  const [file, setFile] = useState<File | null>(null);
  const [preflight, setPreflight] = useState<Preflight>({ rootCid: null, warning: false });
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = phase !== 'idle';

  const reset = useCallback(() => {
    setFile(null);
    setPreflight({ rootCid: null, warning: false });
    setName('');
    setPhase('idle');
    setProgress(0);
    setError(null);
    setDragOver(false);
  }, []);

  const handleClose = () => {
    if (busy) return; // don't lose an in-flight upload by accident
    reset();
    onClose();
  };

  const selectFile = async (selected: File) => {
    setError(null);
    setPreflight({ rootCid: null, warning: false });

    if (selected.size > maxCarBytes) {
      setFile(null);
      setError(`${t.pins.importDagErrTooLarge || 'File exceeds the maximum allowed size'} (${formatBytes(maxCarBytes)})`);
      return;
    }
    setFile(selected);

    try {
      const roots = await preflightCarHeader(selected);
      if (roots.length !== 1) {
        setFile(null);
        setError(t.pins.importDagMultiRootError || 'This CAR file has multiple roots. Only single-root CAR files can be imported.');
        return;
      }
      setPreflight({ rootCid: roots[0], warning: false });
    } catch {
      // Unreadable header client-side — let the server decide.
      setPreflight({ rootCid: null, warning: true });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) void selectFile(dropped);
  };

  const startImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;

    setError(null);
    setPhase('uploading');
    setProgress(0);

    // Encrypt the pin name client-side, exactly like Add Pin (forward-only privacy).
    let pinName = name.trim();
    if (pinName && user?.email && user?.id) {
      try {
        const key = await deriveEncryptionKey(user.provider as 'google' | 'apple', user.id, user.email);
        const encrypted = await encrypt(new TextEncoder().encode(pinName), key);
        pinName = btoa(String.fromCharCode(...encrypted));
      } catch { /* encryption failed, send plaintext */ }
    }

    const form = new FormData();
    if (pinName) form.append('name', pinName);
    form.append('file', file, file.name || 'import.car');

    // XMLHttpRequest: fetch() still has no upload progress events.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/pins/import-dag');
    xhr.withCredentials = true;

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        setProgress(pct);
        // nginx buffers the body, so 100% only means "received by the proxy";
        // validation + cluster import happen before the response arrives.
        if (pct >= 100) setPhase('importing');
      }
    };

    xhr.onerror = () => {
      setPhase('idle');
      setError(t.pins.importDagErrInvalid || 'Failed to import CAR file');
    };

    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 202) {
        reset();
        onImported();
        return;
      }
      setPhase('idle');
      let serverMessage = '';
      try {
        serverMessage = JSON.parse(xhr.responseText)?.error || '';
      } catch { /* non-JSON error body */ }
      if (xhr.status === 402) {
        setError(serverMessage || t.pins.importDagErrQuota || 'Storage quota exceeded — please add credits');
      } else if (xhr.status === 413) {
        setError(`${t.pins.importDagErrTooLarge || 'File exceeds the maximum allowed size'} (${formatBytes(maxCarBytes)})`);
      } else {
        setError(serverMessage || t.pins.importDagErrInvalid || 'Invalid CAR file');
      }
    };

    xhr.send(form);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="p-6 border-b border-gray-100">
          <h2 className="text-xl font-semibold text-gray-900">
            {t.pins.importDagTitle || 'Import DAG from CAR file'}
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {t.pins.importDagDesc || 'Upload a CAR file (e.g. created with "ipfs dag export"). Its blocks are imported into the IPFS cluster and the root CID is pinned to your account.'}
          </p>
        </div>

        <form onSubmit={startImport} className="p-6 space-y-4">
          {/* Drop zone / file picker */}
          <div
            onClick={() => !busy && fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors
              ${dragOver ? 'border-primary-500 bg-primary-50' : 'border-gray-300 hover:border-gray-400'}
              ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".car,application/vnd.ipld.car"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const selected = e.target.files?.[0];
                if (selected) void selectFile(selected);
                e.target.value = ''; // allow re-selecting the same file
              }}
            />
            <svg className="w-8 h-8 mx-auto text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3-3m0 0l3 3m-3-3v9" transform="translate(0,-3)" />
            </svg>
            {file ? (
              <div className="text-sm">
                <p className="font-medium text-gray-900 break-all">{file.name}</p>
                <p className="text-gray-500 mt-1">{formatBytes(file.size)}</p>
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                {t.pins.importDagDropHint || 'Drag & drop a .car file here, or click to select'}
              </p>
            )}
          </div>

          {/* Preflight result */}
          {file && preflight.rootCid && (
            <div className="bg-gray-50 rounded-lg p-3 text-xs">
              <span className="font-semibold text-gray-700">{t.pins.importDagRootCid || 'Root CID'}: </span>
              <span className="font-mono text-gray-600 break-all">{preflight.rootCid}</span>
            </div>
          )}
          {file && preflight.warning && (
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-xs text-orange-700">
              {t.pins.importDagPreviewUnavailable || 'Could not read the CAR header — the file will still be validated by the server.'}
            </div>
          )}

          {/* Optional name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t.pins.nameLabel}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.pins.namePlaceholder}
              maxLength={255}
              disabled={busy}
              className="input w-full"
            />
          </div>

          {/* Progress */}
          {busy && (
            <div className="space-y-2">
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-2 rounded-full transition-all ${phase === 'importing' ? 'bg-blue-500 animate-pulse w-full' : 'bg-primary-600'}`}
                  style={phase === 'uploading' ? { width: `${progress}%` } : undefined}
                />
              </div>
              <p className="text-xs text-gray-500 text-center">
                {phase === 'uploading'
                  ? `${t.pins.importDagUploading || 'Uploading…'} ${progress}%`
                  : t.pins.importDagImporting || 'Validating and importing…'}
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4">
            <button type="button" onClick={handleClose} disabled={busy} className="btn-secondary disabled:opacity-50">
              {t.pins.cancel}
            </button>
            <button type="submit" disabled={!file || busy} className="btn-primary disabled:opacity-50">
              {busy
                ? (phase === 'uploading' ? t.pins.importDagUploading || 'Uploading…' : t.pins.importDagImporting || 'Importing…')
                : t.pins.importDagImport || 'Import'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
