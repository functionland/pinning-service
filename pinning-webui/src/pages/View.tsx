import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import {
  parseCurrentShareUrl,
  fetchSharedContent,
  fetchSharedContentV2,
  processSharePayload,
  processSharePayloadV2,
  isV2Payload,
  getViewerType,
  createBlobUrl,
  revokeBlobUrl,
  isPasswordProtectedPayload,
  decryptPasswordProtectedPayload,
  type SharePayload,
  type ProcessedShareData,
  type ProcessedShareDataV2,
  type FolderFileEntry,
  type ViewerType,
} from '../services/sharingService';
import { createShareClient, acceptShareToken, decryptWithAcceptedShare } from '../services/fulaClientService';
import { downloadBlob } from '../services/encryptionService';
import LanguageSelector from '../components/LanguageSelector';

// Format expiry from date string
function formatExpiryFromDate(expiresAt: string): string {
  const expiry = new Date(expiresAt).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((expiry - now) / 1000));

  if (seconds <= 0) return 'Expired';
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
  return `${Math.floor(seconds / 86400)} days`;
}

interface ViewState {
  loading: boolean;
  error: string | null;
  needsPassword: boolean;
  payload: SharePayload | null;
  shareData: ProcessedShareData | null;
  shareDataV2: ProcessedShareDataV2 | null;
  expiresAt: string | null;
  content: {
    data: Uint8Array;
    mimeType: string;
    filename: string;
    blobUrl: string;
  } | null;
}

export default function View() {
  const { shareId } = useParams<{ shareId: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [state, setState] = useState<ViewState>({
    loading: true,
    error: null,
    needsPassword: false,
    payload: null,
    shareData: null,
    shareDataV2: null,
    expiresAt: null,
    content: null,
  });

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [decrypting, setDecrypting] = useState(false);

  // Parse URL on mount
  useEffect(() => {
    const parseUrl = async () => {
      try {
        const parsed = parseCurrentShareUrl();

        if (!parsed) {
          setState(s => ({
            ...s,
            loading: false,
            error: 'Invalid share link. The link may be malformed or incomplete.',
          }));
          return;
        }

        const { shareId, payload } = parsed;

        // Check if this is a password-protected link
        if (isPasswordProtectedPayload(payload)) {
          console.log('[View] Password-protected link detected');
          setState(s => ({
            ...s,
            loading: false,
            needsPassword: true,
            payload: payload,
          }));
          return;
        }

        // Check if we have the secret key (sk) for public links
        if (!payload.sk) {
          setState(s => ({
            ...s,
            loading: false,
            error: 'Invalid share link. Missing secret key.',
          }));
          return;
        }

        try {
          // Check if this is a v2 payload (fula_client format)
          if (isV2Payload(payload)) {
            console.log('[View] V2 payload detected, using fula_client');
            const shareDataV2 = await processSharePayloadV2(payload, shareId);

            // Check if expired (v2 uses Unix timestamp)
            if (shareDataV2.expiresAt) {
              const now = Math.floor(Date.now() / 1000);
              if (shareDataV2.expiresAt < now) {
                setState(s => ({
                  ...s,
                  loading: false,
                  error: 'This share link has expired.',
                  expiresAt: new Date(shareDataV2.expiresAt * 1000).toISOString(),
                }));
                return;
              }
            }

            setState(s => ({
              ...s,
              payload: payload,
              shareDataV2,
              expiresAt: shareDataV2.expiresAt
                ? new Date(shareDataV2.expiresAt * 1000).toISOString()
                : null,
            }));

            // Fetch and decrypt the content using fula_client
            await loadContentV2(shareDataV2);
          } else {
            // V1 payload - use existing manual decryption
            console.log('[View] V1 payload detected, using manual decryption');
            const shareData = await processSharePayload(payload, shareId);

            setState(s => ({
              ...s,
              payload: payload,
              shareData,
              expiresAt: shareData.expiresAt || null,
            }));

            // Check if expired
            if (shareData.expiresAt) {
              const expiry = new Date(shareData.expiresAt).getTime();
              if (expiry < Date.now()) {
                setState(s => ({
                  ...s,
                  loading: false,
                  error: 'This share link has expired.',
                }));
                return;
              }
            }

            // Fetch and decrypt the content
            await loadContent(shareData);
          }
        } catch (error) {
          console.error('[View] Decryption error:', error);
          setState(s => ({
            ...s,
            loading: false,
            error: error instanceof Error ? error.message : 'Failed to decrypt share link.',
          }));
        }
      } catch (error) {
        console.error('[View] Parse error:', error);
        setState(s => ({
          ...s,
          loading: false,
          error: 'Failed to parse share link.',
        }));
      }
    };

    parseUrl();
  }, [shareId]);

  // Load and decrypt content (v1)
  const loadContent = useCallback(async (shareData: ProcessedShareData) => {
    setState(s => ({ ...s, loading: true, error: null }));

    try {
      const { data, mimeType, filename } = await fetchSharedContent(shareData);
      const blobUrl = createBlobUrl(data, mimeType);

      setState(s => ({
        ...s,
        loading: false,
        needsPassword: false,
        shareData,
        expiresAt: shareData.expiresAt || null,
        content: { data, mimeType, filename, blobUrl },
      }));
    } catch (error) {
      console.error('[View] Load error:', error);
      setState(s => ({
        ...s,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load shared content.',
      }));
    }
  }, []);

  // Load and decrypt content (v2 - using fula_client)
  const loadContentV2 = useCallback(async (shareDataV2: ProcessedShareDataV2) => {
    // For folder shares, fetch file manifest from server and show listing
    if (shareDataV2.isFolder) {
      console.log('[View] Folder share detected, fetching manifest from server');

      // Fetch server manifest (canonical source for temporal folder shares)
      try {
        const resp = await fetch(`/api/share/v2/manifest/${shareDataV2.shareId}`);
        if (resp.ok) {
          const manifest = await resp.json();
          if (manifest.files && Array.isArray(manifest.files)) {
            shareDataV2.files = manifest.files.map((f: { n: string; c: string; s: number; t?: string } | FolderFileEntry) => {
              if ('name' in f) return f;
              return { name: f.n, cid: f.c, size: f.s, tokenJson: f.t || undefined };
            });
            console.log('[View] Loaded folder manifest from server:', shareDataV2.files.length, 'files');
          }
        } else {
          console.log('[View] Manifest fetch returned', resp.status, '- using URL fragment fallback');
        }
      } catch (e) {
        console.log('[View] Manifest fetch failed, using URL fragment fallback:', e);
      }

      // If we have files (from server or URL fragment fallback), show folder view
      if (shareDataV2.files?.length) {
        setState(s => ({
          ...s,
          loading: false,
          needsPassword: false,
          shareDataV2,
          expiresAt: shareDataV2.expiresAt
            ? new Date(shareDataV2.expiresAt * 1000).toISOString()
            : null,
        }));
        return;
      }

      // No files from server or fragment — show error
      setState(s => ({
        ...s,
        loading: false,
        error: 'Folder manifest not available. The share may have expired or the server is unreachable.',
      }));
      return;
    }

    setState(s => ({ ...s, loading: true, error: null }));

    try {
      const { data, mimeType, filename } = await fetchSharedContentV2(shareDataV2);
      const blobUrl = createBlobUrl(data, mimeType);

      setState(s => ({
        ...s,
        loading: false,
        needsPassword: false,
        shareDataV2,
        expiresAt: shareDataV2.expiresAt
          ? new Date(shareDataV2.expiresAt * 1000).toISOString()
          : null,
        content: { data, mimeType, filename, blobUrl },
      }));
    } catch (error) {
      console.error('[View] Load error (v2):', error);
      setState(s => ({
        ...s,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load shared content.',
      }));
    }
  }, []);

  // Handle password submission for password-protected links
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!state.payload || !password.trim()) return;

    setDecrypting(true);
    setState(s => ({ ...s, error: null }));

    try {
      // Decrypt the inner payload using the password
      console.log('[View] Decrypting password-protected payload...');
      const innerPayload = await decryptPasswordProtectedPayload(state.payload, password);

      // Get shareId from URL
      const parsed = parseCurrentShareUrl();
      if (!parsed) {
        throw new Error('Failed to parse share URL');
      }

      // Check if inner payload is v2 or v1
      if (isV2Payload(innerPayload)) {
        console.log('[View] Password-protected v2 payload detected');
        const shareDataV2 = await processSharePayloadV2(innerPayload, parsed.shareId);

        // Check if expired (v2 uses Unix timestamp)
        if (shareDataV2.expiresAt) {
          const now = Math.floor(Date.now() / 1000);
          if (shareDataV2.expiresAt < now) {
            setState(s => ({
              ...s,
              loading: false,
              needsPassword: false,
              error: 'This share link has expired.',
              expiresAt: new Date(shareDataV2.expiresAt * 1000).toISOString(),
            }));
            setDecrypting(false);
            return;
          }
        }

        // Update state with decrypted payload
        setState(s => ({
          ...s,
          payload: innerPayload,
          shareDataV2,
          expiresAt: shareDataV2.expiresAt
            ? new Date(shareDataV2.expiresAt * 1000).toISOString()
            : null,
        }));

        // Fetch and decrypt the content using fula_client
        await loadContentV2(shareDataV2);
      } else {
        // V1 payload - use existing manual decryption
        console.log('[View] Password-protected v1 payload detected');
        const shareData = await processSharePayload(innerPayload, parsed.shareId);

        // Check if expired
        if (shareData.expiresAt) {
          const expiry = new Date(shareData.expiresAt).getTime();
          if (expiry < Date.now()) {
            setState(s => ({
              ...s,
              loading: false,
              needsPassword: false,
              error: 'This share link has expired.',
            }));
            setDecrypting(false);
            return;
          }
        }

        // Update state with decrypted payload
        setState(s => ({
          ...s,
          payload: innerPayload,
          shareData,
          expiresAt: shareData.expiresAt || null,
        }));

        // Fetch and decrypt the content
        await loadContent(shareData);
      }
    } catch (error) {
      console.error('[View] Password decryption error:', error);
      setState(s => ({
        ...s,
        error: error instanceof Error ? error.message : 'Failed to decrypt. Please check your password.',
      }));
    } finally {
      setDecrypting(false);
    }
  };

  // Handle download
  const handleDownload = () => {
    if (!state.content) return;
    downloadBlob(state.content.data, state.content.filename, state.content.mimeType);
  };

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (state.content?.blobUrl) {
        revokeBlobUrl(state.content.blobUrl);
      }
    };
  }, [state.content?.blobUrl]);

  // Loading state
  if (state.loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600">{t.view?.loading || 'Loading shared content...'}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (state.error && !state.needsPassword) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="absolute top-4 right-4">
          <LanguageSelector />
        </div>
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">X</span>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              {t.view?.errorTitle || 'Unable to Access'}
            </h1>
            <p className="text-gray-600 mb-6">{state.error}</p>
            {state.expiresAt && (
              <p className="text-sm text-gray-500 mb-4">
                {new Date(state.expiresAt).getTime() < Date.now()
                  ? (t.view?.expiredAt || 'Expired')
                  : (t.view?.expiresOn || 'Expires')}: {new Date(state.expiresAt).toLocaleString()}
              </p>
            )}
            <button
              onClick={() => navigate('/')}
              className="btn-primary"
            >
              {t.view?.goHome || 'Go to Homepage'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Password prompt
  if (state.needsPassword) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="absolute top-4 right-4">
          <LanguageSelector />
        </div>
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-lg p-8">
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-3xl">***</span>
              </div>
              <h1 className="text-xl font-bold text-gray-900">
                {t.view?.passwordRequired || 'Password Required'}
              </h1>
              <p className="text-gray-600 mt-2">
                {t.view?.passwordDesc || 'This content is password-protected. Enter the password to continue.'}
              </p>
            </div>

            {state.error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 text-red-700 text-sm">
                {state.error}
              </div>
            )}

            <form onSubmit={handlePasswordSubmit}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t.view?.password || 'Password'}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input w-full pr-10"
                    placeholder={t.view?.enterPassword || 'Enter password'}
                    autoFocus
                    disabled={decrypting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={!password.trim() || decrypting}
                className="btn-primary w-full flex items-center justify-center"
              >
                {decrypting ? (
                  <>
                    <span className="animate-spin mr-2">...</span>
                    {t.view?.decrypting || 'Decrypting...'}
                  </>
                ) : (
                  t.view?.unlock || 'Unlock Content'
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Content viewer
  if (state.content) {
    const viewerType = getViewerType(state.content.mimeType);

    return (
      <div className="min-h-screen bg-gray-900 flex flex-col">
        {/* Header */}
        <div className="bg-gray-800 border-b border-gray-700 px-3 sm:px-4 py-3 flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
            <h1 className="text-white font-medium truncate text-sm sm:text-base">
              {state.content.filename}
            </h1>
            {state.expiresAt && (
              <span className="text-gray-400 text-xs sm:text-sm hidden sm:inline whitespace-nowrap">
                {t.view?.expiresIn || 'Expires in'}: {formatExpiryFromDate(state.expiresAt)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <button
              onClick={handleDownload}
              className="bg-primary-600 hover:bg-primary-700 text-white px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap"
            >
              {t.view?.download || 'Download'}
            </button>
            <LanguageSelector />
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
          <ContentViewer
            type={viewerType}
            blobUrl={state.content.blobUrl}
            mimeType={state.content.mimeType}
            data={state.content.data}
            filename={state.content.filename}
            onDownload={handleDownload}
          />
        </div>
      </div>
    );
  }

  // Folder listing view
  if (state.shareDataV2?.isFolder && state.shareDataV2?.files?.length) {
    return (
      <FolderView
        shareData={state.shareDataV2}
        expiresAt={state.expiresAt}
      />
    );
  }

  return null;
}

// Folder view component for shared folders
function FolderView({ shareData, expiresAt }: { shareData: ProcessedShareDataV2; expiresAt: string | null }) {
  const { t } = useLanguage();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const files = shareData.files || [];
  const folderName = shareData.name || 'Shared Folder';
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function getFileIcon(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const icons: Record<string, string> = {
      jpg: '\ud83d\uddbc\ufe0f', jpeg: '\ud83d\uddbc\ufe0f', png: '\ud83d\uddbc\ufe0f', gif: '\ud83d\uddbc\ufe0f', webp: '\ud83d\uddbc\ufe0f', svg: '\ud83d\uddbc\ufe0f',
      mp4: '\ud83c\udfac', mov: '\ud83c\udfac', avi: '\ud83c\udfac', mkv: '\ud83c\udfac', webm: '\ud83c\udfac',
      mp3: '\ud83c\udfb5', wav: '\ud83c\udfb5', flac: '\ud83c\udfb5', aac: '\ud83c\udfb5', ogg: '\ud83c\udfb5',
      pdf: '\ud83d\udcc4', doc: '\ud83d\udcc4', docx: '\ud83d\udcc4', txt: '\ud83d\udcc4', rtf: '\ud83d\udcc4',
      zip: '\ud83d\udce6', rar: '\ud83d\udce6', '7z': '\ud83d\udce6', tar: '\ud83d\udce6', gz: '\ud83d\udce6',
    };
    return icons[ext] || '\ud83d\udcc1';
  }

  async function handleDownloadFile(file: FolderFileEntry) {
    setDownloading(file.cid);
    setError(null);

    try {
      const proxyEndpoint = `${window.location.origin}/api/share/v2/fetch`;
      const client = await createShareClient(shareData.secretKey, proxyEndpoint);
      // Use per-file token if available, fallback to main token
      const tokenJson = file.tokenJson || shareData.tokenJson;
      const acceptedShare = await acceptShareToken(client, tokenJson);
      const decryptedData = await decryptWithAcceptedShare(client, shareData.bucket, file.cid, acceptedShare);

      downloadBlob(new Uint8Array(decryptedData), file.name, '');
    } catch (err) {
      console.error('[FolderView] Download error for', file.name, err);
      setError(`Failed to download "${file.name}": ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 truncate">
              {folderName}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {files.length} file{files.length !== 1 ? 's' : ''} &middot; {formatSize(totalSize)}
              {expiresAt && (
                <span className="ml-2">
                  &middot; {t.view?.expiresIn || 'Expires in'}: {formatExpiryFromDate(expiresAt)}
                </span>
              )}
            </p>
          </div>
          <LanguageSelector />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 mt-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
            {error}
          </div>
        </div>
      )}

      {/* File list */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 divide-y divide-gray-100">
          {files.map((file) => (
            <div
              key={file.cid}
              className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <span className="text-xl flex-shrink-0">{getFileIcon(file.name)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                <p className="text-xs text-gray-500">{formatSize(file.size)}</p>
              </div>
              <button
                onClick={() => handleDownloadFile(file)}
                disabled={downloading === file.cid}
                className="flex-shrink-0 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              >
                {downloading === file.cid ? 'Downloading...' : (t.view?.download || 'Download')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Content viewer component
interface ContentViewerProps {
  type: ViewerType;
  blobUrl: string;
  mimeType: string;
  data: Uint8Array;
  filename: string;
  onDownload: () => void;
}

function ContentViewer({ type, blobUrl, mimeType, data, filename, onDownload }: ContentViewerProps) {
  const { t } = useLanguage();

  switch (type) {
    case 'image':
      return (
        <div className="max-w-full max-h-full">
          <img
            src={blobUrl}
            alt={filename}
            className="max-w-full max-h-[calc(100vh-120px)] object-contain rounded-lg shadow-lg"
          />
        </div>
      );

    case 'video':
      return (
        <video
          src={blobUrl}
          controls
          autoPlay
          className="max-w-full max-h-[calc(100vh-120px)] rounded-lg shadow-lg"
        >
          Your browser does not support video playback.
        </video>
      );

    case 'audio':
      return (
        <div className="bg-gray-800 rounded-2xl p-8 max-w-md w-full">
          <div className="text-center mb-6">
            <div className="w-24 h-24 bg-primary-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl">...</span>
            </div>
            <h2 className="text-white font-medium truncate">{filename}</h2>
          </div>
          <audio src={blobUrl} controls autoPlay className="w-full">
            Your browser does not support audio playback.
          </audio>
        </div>
      );

    case 'text':
      const textContent = new TextDecoder().decode(data);
      const isJson = mimeType === 'application/json';

      return (
        <div className="bg-gray-800 rounded-lg p-6 max-w-4xl w-full max-h-[calc(100vh-120px)] overflow-auto">
          <pre className={`text-gray-100 text-sm whitespace-pre-wrap ${isJson ? 'font-mono' : ''}`}>
            {isJson ? JSON.stringify(JSON.parse(textContent), null, 2) : textContent}
          </pre>
        </div>
      );

    case 'pdf':
      return (
        <object
          data={blobUrl}
          type="application/pdf"
          className="w-full h-[calc(100vh-120px)] rounded-lg bg-white"
        >
          {/* Fallback when PDF cannot be displayed */}
          <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
            <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl text-red-600">PDF</span>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">{filename}</h2>
            <p className="text-gray-600 mb-6">
              {t.view?.pdfNotSupported || 'PDF preview is not supported on this device. Please download the file to view it.'}
            </p>
            <button onClick={onDownload} className="btn-primary">
              {t.view?.download || 'Download'}
            </button>
          </div>
        </object>
      );

    case 'document':
      // For Office documents, show download prompt
      return (
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">D</span>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">{filename}</h2>
          <p className="text-gray-600 mb-6">
            {t.view?.documentPreview || 'This document type cannot be previewed in the browser. Download to view.'}
          </p>
          <button onClick={onDownload} className="btn-primary">
            {t.view?.download || 'Download'}
          </button>
        </div>
      );

    case 'download':
    default:
      return (
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">F</span>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">{filename}</h2>
          <p className="text-gray-500 text-sm mb-6">{mimeType}</p>
          <button onClick={onDownload} className="btn-primary">
            {t.view?.download || 'Download'}
          </button>
        </div>
      );
  }
}
