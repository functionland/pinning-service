import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import {
  parseCurrentShareUrl,
  fetchSharedContent,
  isShareExpired,
  formatExpiry,
  getViewerType,
  createBlobUrl,
  revokeBlobUrl,
  type SharePayload,
  type ShareToken,
  type ViewerType,
} from '../services/sharingService';
import { downloadBlob, getExtensionFromMimeType } from '../services/encryptionService';
import LanguageSelector from '../components/LanguageSelector';

interface ViewState {
  loading: boolean;
  error: string | null;
  needsPassword: boolean;
  payload: SharePayload | null;
  token: ShareToken | null;
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
    token: null,
    content: null,
  });

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [decrypting, setDecrypting] = useState(false);

  // Parse URL on mount
  useEffect(() => {
    const parseUrl = () => {
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

        // Parse the token from payload
        let token: ShareToken;
        try {
          token = JSON.parse(parsed.payload.t) as ShareToken;
        } catch {
          setState(s => ({
            ...s,
            loading: false,
            error: 'Invalid share token format.',
          }));
          return;
        }

        // Check if expired
        if (isShareExpired(token)) {
          setState(s => ({
            ...s,
            loading: false,
            error: 'This share link has expired.',
            token,
          }));
          return;
        }

        // Check if password-protected
        if (parsed.payload.pwd) {
          setState(s => ({
            ...s,
            loading: false,
            needsPassword: true,
            payload: parsed.payload,
            token,
          }));
          return;
        }

        // Public link - decrypt automatically
        setState(s => ({
          ...s,
          payload: parsed.payload,
          token,
        }));

        loadContent(parsed.payload);
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

  // Load and decrypt content
  const loadContent = useCallback(async (payload: SharePayload, pwd?: string) => {
    setState(s => ({ ...s, loading: true, error: null }));

    try {
      const { data, mimeType, filename } = await fetchSharedContent(payload, pwd);
      const blobUrl = createBlobUrl(data, mimeType);

      setState(s => ({
        ...s,
        loading: false,
        needsPassword: false,
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

  // Handle password submission
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!password.trim() || !state.payload) return;

    setDecrypting(true);

    try {
      await loadContent(state.payload, password);
    } catch (error) {
      setState(s => ({
        ...s,
        error: 'Incorrect password or decryption failed.',
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
            {state.token && (
              <p className="text-sm text-gray-500 mb-4">
                {t.view?.expiredAt || 'Expired'}: {state.token.expiresAt}
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

            {state.token && (
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <p className="text-sm text-gray-600">
                  <span className="font-medium">{t.view?.expiresIn || 'Expires in'}:</span>{' '}
                  {formatExpiry(state.token)}
                </p>
              </div>
            )}

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
        <div className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-white font-medium truncate max-w-md">
              {state.content.filename}
            </h1>
            {state.token && (
              <span className="text-gray-400 text-sm hidden sm:inline">
                {t.view?.expiresIn || 'Expires in'}: {formatExpiry(state.token)}
              </span>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleDownload}
              className="bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
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

  return null;
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
        <iframe
          src={blobUrl}
          className="w-full h-[calc(100vh-120px)] rounded-lg"
          title={filename}
        />
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
