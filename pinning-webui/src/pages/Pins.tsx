import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { S3Client, ListObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  deriveEncryptionKey,
  deriveEncryptionKeyBytes,
  derivePlaylistEncryptionKey,
  exportKey,
  importKey,
  encrypt,
  fetchAndDecrypt,
  downloadBlob,
  getExtensionFromMimeType,
  computeHashedUserId,
  decrypt,
  decryptEnvelope,
  isJsonEnvelope,
  parseEnvelope,
  isChunkedEnvelopeV2,
  decryptChunkedEnvelopeV2,
} from '../services/encryptionService';
import { getFulaClient, fetchAndDecryptFula, fetchAndDecryptByCid, fetchAndDecryptByStorageKey, listFulaBuckets, listDecryptedFiles, listFulaDirectory } from '../services/fulaClientService';
import {
  storeEncryptionKey,
  retrieveEncryptionKey,
  hasValidKey,
} from '../services/secureStorage';
import {
  OutgoingShare,
  Playlist,
  parseOutgoingShares,
  parsePlaylists,
  detectMimeType,
} from '../services/sharingService';

// S3 endpoint for FxFiles storage
const S3_ENDPOINT = 'https://s3.cloud.fx.land';

// Helper to create S3 client with JWT token
function createS3Client(jwtToken: string): S3Client {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: 'us-east-1', // Required but server ignores it
    credentials: {
      accessKeyId: `JWT:${jwtToken}`,
      secretAccessKey: 'not-used',
    },
    forcePathStyle: true,
  });
}

// Helper to convert S3 body stream to Uint8Array
async function streamToUint8Array(stream: ReadableStream<Uint8Array> | Blob | null): Promise<Uint8Array> {
  if (!stream) throw new Error('Empty response body');

  if (stream instanceof Blob) {
    return new Uint8Array(await stream.arrayBuffer());
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

interface Pin {
  request_id: string;
  cid: string;
  name: string;
  created_at: string;
  status: string;
  size: number;
}

interface PinsResponse {
  pins: Pin[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface SharedWithMeItem {
  cid: string;
  name: string;
  sharedBy: string;
  sharedAt: string;
  expiresAt?: string;
  permissions: string[];
}

interface SharedWithMeResponse {
  shares: SharedWithMeItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

type TabType = 'myPins' | 'sharedWithMe' | 'sharedByMe' | 'playlists' | 'fxFiles';

// FxFiles Tab Types
interface FxBucket {
  name: string;
  creationDate?: string;
}

interface FxFileItem {
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  isDirectory: boolean;
  path: string;
}

interface FxFilesNavigationState {
  currentBucket: string | null;
  currentPath: string;
  breadcrumbs: { label: string; path: string }[];
}

export default function Pins() {
  const { t } = useLanguage();
  const { user } = useAuth();

  // Active tab state
  const [activeTab, setActiveTab] = useState<TabType>('fxFiles');

  // Track which tabs have been loaded (for lazy loading)
  const [loadedTabs, setLoadedTabs] = useState<Set<TabType>>(new Set(['fxFiles']));

  // My Pins state
  const [data, setData] = useState<PinsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCid, setNewCid] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedValue, setExpandedValue] = useState<{ type: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshingPins, setRefreshingPins] = useState<Set<string>>(new Set());
  const [selectedPins, setSelectedPins] = useState<Set<string>>(new Set());
  const [unpinning, setUnpinning] = useState(false);

  // Shared With Me state
  const [sharedWithMeData, setSharedWithMeData] = useState<SharedWithMeResponse | null>(null);
  const [sharedWithMeLoading, setSharedWithMeLoading] = useState(false);
  const [sharedWithMeError, setSharedWithMeError] = useState<string | null>(null);
  const [sharedWithMePage, setSharedWithMePage] = useState(1);

  // Shared By Me state
  const [sharedByMeData, setSharedByMeData] = useState<OutgoingShare[]>([]);
  const [sharedByMeLoading, setSharedByMeLoading] = useState(false);
  const [sharedByMeError, setSharedByMeError] = useState<string | null>(null);
  const [sharedByMePage, setSharedByMePage] = useState(1);
  const [sharedByMeNeedsKey, setSharedByMeNeedsKey] = useState(false);
  const ITEMS_PER_PAGE = 20;

  // Playlists state
  const [playlistsData, setPlaylistsData] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);
  const [playlistsPage, setPlaylistsPage] = useState(1);

  // FxFiles state
  const [fxFilesLoading, setFxFilesLoading] = useState(false);
  const [fxFilesError, setFxFilesError] = useState<string | null>(null);
  const [fxBuckets, setFxBuckets] = useState<FxBucket[]>([]);
  const [fxFiles, setFxFiles] = useState<FxFileItem[]>([]);
  const [fxFilesPage, setFxFilesPage] = useState(1);
  const FX_FILES_PER_PAGE = 50; // Pagination to prevent UI freeze on large buckets
  const [fxNavigation, setFxNavigation] = useState<FxFilesNavigationState>({
    currentBucket: null,
    currentPath: '/',
    breadcrumbs: [],
  });
  const [fxDownloading, setFxDownloading] = useState<Set<string>>(new Set());
  const [fxPreviewData, setFxPreviewData] = useState<{
    file: FxFileItem;
    blobUrl: string;
    mimeType: string;
  } | null>(null);

  // Decryption state
  const [encryptionKeyReady, setEncryptionKeyReady] = useState(false);
  const [decryptingPins, setDecryptingPins] = useState<Set<string>>(new Set());
  const [decryptionError, setDecryptionError] = useState<string | null>(null);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [settingUpKey, setSettingUpKey] = useState(false);
  const [pendingDecryptPin, setPendingDecryptPin] = useState<Pin | null>(null);

  // Decrypted pin names (keyed by request_id)
  const [decryptedPinNames, setDecryptedPinNames] = useState<Record<string, string>>({});

  // Nodes modal state
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [nodesModalData, setNodesModalData] = useState<{
    requestId: string;
    cid: string;
    nodes: Array<{
      peer_id: string;
      peer_name?: string;
      status: string;
      error?: string;
    }>;
  } | null>(null);
  const [showAllNodes, setShowAllNodes] = useState(false);

  // Load tab data on tab change (lazy loading)
  useEffect(() => {
    if (!loadedTabs.has(activeTab)) {
      setLoadedTabs(prev => new Set(prev).add(activeTab));
    }

    // Fetch data for the active tab
    switch (activeTab) {
      case 'myPins':
        fetchPins();
        break;
      case 'sharedWithMe':
        if (!sharedWithMeData) fetchSharedWithMe();
        break;
      case 'sharedByMe':
        if (sharedByMeData.length === 0 && !sharedByMeLoading) fetchSharedByMe();
        break;
      case 'playlists':
        if (playlistsData.length === 0 && !playlistsLoading) fetchPlaylists();
        break;
      case 'fxFiles':
        if (fxBuckets.length === 0 && !fxFilesLoading && !fxNavigation.currentBucket) fetchFxBuckets();
        break;
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'myPins') {
      fetchPins();
    }
  }, [page, searchQuery]);

  // Check if encryption key is available on mount
  useEffect(() => {
    const checkEncryptionKey = async () => {
      if (user?.email) {
        const hasKey = await hasValidKey(user.email);
        setEncryptionKeyReady(hasKey);
      }
    };
    checkEncryptionKey();
  }, [user]);

  // Timeout for download operations (5 minutes)
  const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

  // Download and decrypt a pin with provided key bytes (used after setup)
  const downloadDecryptedWithKey = async (pin: Pin, keyBytes: Uint8Array) => {
    console.log('[Decryption] downloadDecryptedWithKey called for pin:', pin.cid);
    
    setDecryptingPins(prev => new Set(prev).add(pin.request_id));
    setDecryptionError(null);

    // Set timeout to auto-clear loading state in case of stuck operation
    const timeoutId = setTimeout(() => {
      console.warn('[Decryption] Download timeout reached, clearing loading state');
      setDecryptingPins(prev => {
        const next = new Set(prev);
        next.delete(pin.request_id);
        return next;
      });
      setDecryptionError('Download timed out. Please try again.');
    }, DOWNLOAD_TIMEOUT_MS);

    try {
      const key = await importKey(keyBytes);
      console.log('[Decryption] Key imported, fetching and decrypting...');

      // Fetch and decrypt from IPFS gateway
      const { data, mimeType } = await fetchAndDecrypt(
        pin.cid,
        key,
        'https://ipfs.cloud.fx.land/gateway'
      );
      console.log('[Decryption] Decrypted successfully, mimeType:', mimeType);

      // Generate filename (use decrypted name if available)
      const ext = getExtensionFromMimeType(mimeType);
      const displayName = decryptedPinNames[pin.request_id] || pin.name;
      const filename = displayName
        ? (displayName.includes('.') ? displayName : `${displayName}${ext}`)
        : `decrypted-${pin.cid.slice(0, 8)}${ext}`;

      // Trigger download
      console.log('[Decryption] Downloading as:', filename);
      downloadBlob(data, filename, mimeType);
    } catch (err) {
      console.error('[Decryption] Download failed:', err);
      const message = err instanceof Error ? err.message : 'Decryption failed';
      if (message.includes('Decryption failed')) {
        setDecryptionError('This file may not be encrypted or was encrypted with a different key');
      } else {
        setDecryptionError(message);
      }
    } finally {
      clearTimeout(timeoutId);
      setDecryptingPins(prev => {
        const next = new Set(prev);
        next.delete(pin.request_id);
        return next;
      });
    }
  };

  // Setup encryption key from user credentials
  const setupEncryptionKey = async () => {
    console.log('[Decryption] setupEncryptionKey called, user:', user);
    
    if (!user?.id || !user?.email) {
      console.error('[Decryption] User missing id or email:', { id: user?.id, email: user?.email });
      setDecryptionError('User not logged in or session expired. Please log out and log in again.');
      return;
    }

    setSettingUpKey(true);
    setDecryptionError(null);

    try {
      console.log('[Decryption] Deriving key for user:', user.id, user.email);
      // Derive key from user ID and email (deriveEncryptionKey uses provider prefix)
      const key = await deriveEncryptionKey(user.provider, user.id, user.email);
      console.log('[Decryption] Key derived successfully');
      
      const keyBytes = await exportKey(key);
      console.log('[Decryption] Key exported, storing...');
      
      // Store key securely
      await storeEncryptionKey(user.email, keyBytes, user.email);
      console.log('[Decryption] Key stored successfully');
      
      setEncryptionKeyReady(true);
      setShowSetupModal(false);
      
      // If there's a pending pin to decrypt, trigger it now
      if (pendingDecryptPin) {
        console.log('[Decryption] Auto-triggering download for pending pin:', pendingDecryptPin.cid);
        const pinToDownload = pendingDecryptPin;
        setPendingDecryptPin(null);
        // Use setTimeout to allow state to update first
        setTimeout(() => downloadDecryptedWithKey(pinToDownload, keyBytes), 100);
      }
    } catch (err) {
      console.error('[Decryption] Setup failed:', err);
      setDecryptionError(err instanceof Error ? err.message : 'Failed to setup encryption key');
    } finally {
      setSettingUpKey(false);
    }
  };

  // Download and decrypt a pin
  const downloadDecrypted = async (pin: Pin) => {
    console.log('[Decryption] downloadDecrypted called for pin:', pin.cid);
    
    if (!user?.email) {
      setDecryptionError('User not logged in');
      return;
    }

    // Check if key is ready, if not show setup modal
    if (!encryptionKeyReady) {
      console.log('[Decryption] Key not ready, showing setup modal');
      setPendingDecryptPin(pin); // Store the pin to download after setup
      setShowSetupModal(true);
      return;
    }

    setDecryptingPins(prev => new Set(prev).add(pin.request_id));
    setDecryptionError(null);

    // Set timeout to auto-clear loading state in case of stuck operation
    const timeoutId = setTimeout(() => {
      console.warn('[Decryption] Download timeout reached, clearing loading state');
      setDecryptingPins(prev => {
        const next = new Set(prev);
        next.delete(pin.request_id);
        return next;
      });
      setDecryptionError('Download timed out. Please try again.');
    }, DOWNLOAD_TIMEOUT_MS);

    try {
      // Step 1: Get encryption key bytes for fula-client
      console.log('[Decryption] Getting encryption key...');
      if (!user.id) {
        throw new Error('User ID not available');
      }
      // Debug: Log key derivation inputs (to compare with FxFiles mobile)
      // FxFiles uses: combinedId = "google:{user.id}", salt = "fula-files-v1:{user.email}"
      console.log('[Decryption] Key derivation inputs:', {
        userId: user.id,
        userIdLength: user.id.length,
        email: user.email,
        combinedId: `google:${user.id}`,
      });
      const keyBytes = await deriveEncryptionKeyBytes(user.provider, user.id, user.email);
      console.log('[Decryption] Derived key first 4 bytes:', Array.from(keyBytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' '));

      // Step 2: Get access token from API
      console.log('[Decryption] Getting access token...');
      const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
      if (!tokenRes.ok) {
        throw new Error('Failed to get API key. Please create one in the API Keys page.');
      }
      const { key: accessToken } = await tokenRes.json();

      // Step 3: Create fula-client
      console.log('[Decryption] Creating fula-client...');
      const client = await getFulaClient(keyBytes, accessToken);

      // Step 4: Fetch and decrypt from S3 (trying each bucket until found)
      console.log('[Decryption] Fetching from S3 via fula-client...');
      const { data } = await fetchAndDecryptByCid(client, pin.cid);

      // Step 5: Detect mime type from decrypted content
      const mimeType = detectMimeType(data);
      console.log('[Decryption] Decrypted successfully, mimeType:', mimeType);

      // Generate filename (use decrypted name if available)
      const ext = getExtensionFromMimeType(mimeType);
      const displayName = decryptedPinNames[pin.request_id] || pin.name;
      const filename = displayName
        ? (displayName.includes('.') ? displayName : `${displayName}${ext}`)
        : `decrypted-${pin.cid.slice(0, 8)}${ext}`;

      // Trigger download
      console.log('[Decryption] Downloading as:', filename);
      downloadBlob(data, filename, mimeType);
    } catch (err) {
      console.error('[Decryption] Download failed:', err);
      const message = err instanceof Error ? err.message : 'Decryption failed';
      if (message.includes('not found in any bucket')) {
        setDecryptionError('File not found in cloud storage. It may have been deleted.');
      } else if (message.includes('API key')) {
        setDecryptionError('Please create an API key in the API Keys page first.');
      } else {
        setDecryptionError(message);
      }
    } finally {
      clearTimeout(timeoutId);
      setDecryptingPins(prev => {
        const next = new Set(prev);
        next.delete(pin.request_id);
        return next;
      });
    }
  };

  // Try to decrypt a pin name; returns original if not encrypted or decryption fails
  const tryDecryptPinName = async (name: string, key: CryptoKey): Promise<string> => {
    if (!name) return '';
    try {
      const bytes = Uint8Array.from(atob(name), c => c.charCodeAt(0));
      if (bytes.length < 28) return name; // too short for nonce+tag = legacy plaintext
      return new TextDecoder().decode(await decrypt(bytes, key));
    } catch {
      return name; // legacy plaintext or invalid base64
    }
  };

  const fetchPins = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (searchQuery.trim()) {
        params.set('search', searchQuery.trim());
      }
      const res = await fetch(`/api/pins?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch pins');
      const result = await res.json();
      setData(result);

      // Decrypt pin names in background
      if (user?.email && user?.id && result.pins?.length > 0) {
        try {
          const key = await deriveEncryptionKey(user.provider as 'google' | 'apple', user.id, user.email);
          const names: Record<string, string> = {};
          for (const pin of result.pins) {
            if (pin.name) {
              names[pin.request_id] = await tryDecryptPinName(pin.name, key);
            }
          }
          setDecryptedPinNames(prev => ({ ...prev, ...names }));
        } catch { /* key derivation failed, show raw names */ }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  // Fetch shared with me data from fula API
  const fetchSharedWithMe = async () => {
    setSharedWithMeLoading(true);
    setSharedWithMeError(null);
    try {
      const params = new URLSearchParams({
        page: String(sharedWithMePage),
        limit: String(ITEMS_PER_PAGE)
      });
      const res = await fetch(`/api/shares/with-me?${params}`, { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 404) {
          // No shares endpoint yet, show empty state
          setSharedWithMeData({ shares: [], total: 0, page: 1, limit: ITEMS_PER_PAGE, totalPages: 0 });
          return;
        }
        throw new Error('Failed to fetch shared items');
      }
      const result = await res.json();
      setSharedWithMeData(result);
    } catch (err) {
      setSharedWithMeError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSharedWithMeLoading(false);
    }
  };

  // Fetch shared by me data using fula-client
  // Bucket: fula-metadata, Key: .fula/shares/{hashedUserId}.json.enc
  const fetchSharedByMe = async () => {
    if (!user?.id || !user?.email) return;
    setSharedByMeLoading(true);
    setSharedByMeError(null);
    try {
      // Step 1: Get encryption key from secure storage
      const keyBytes = await retrieveEncryptionKey(user.email, user.email);
      if (!keyBytes) {
        console.log('[SharedByMe] No encryption key found - user needs to set up decryption first');
        setSharedByMeNeedsKey(true);
        setSharedByMeData([]);
        return;
      }
      setSharedByMeNeedsKey(false);

      // Step 2: Get JWT token for authentication
      const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
      if (!tokenRes.ok) {
        throw new Error('Failed to get API key');
      }
      const { key: jwtToken } = await tokenRes.json();
      console.log('[SharedByMe] Got JWT token');

      // Step 3: Create fula-client
      const fulaClient = await getFulaClient(keyBytes, jwtToken, 'https://s3.cloud.fx.land');
      console.log('[SharedByMe] Created fula-client');

      // Step 4: Compute hashedUserId and construct path
      const hashedUserId = await computeHashedUserId(user.provider, user.id, user.email);
      const s3Key = `.fula/shares/${hashedUserId}.json.enc`;
      console.log('[SharedByMe] Fetching - Bucket: fula-metadata, Key:', s3Key);

      try {
        // Step 5: Fetch and decrypt using fula-client
        const decryptedBytes = await fetchAndDecryptFula(fulaClient, 'fula-metadata', s3Key);
        const jsonText = new TextDecoder().decode(decryptedBytes);
        console.log('[SharedByMe] Decrypted JSON:', jsonText.substring(0, 200));

        const sharesJson = JSON.parse(jsonText);
        const shares = parseOutgoingShares(sharesJson.shares || sharesJson || []);
        setSharedByMeData(shares);
      } catch (fetchErr: any) {
        if (fetchErr.message?.includes('not found') || fetchErr.message?.includes('404')) {
          console.log('[SharedByMe] No shares file found');
          setSharedByMeData([]);
          return;
        }
        throw fetchErr;
      }
    } catch (err) {
      console.error('[SharedByMe] Error:', err);
      setSharedByMeError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSharedByMeLoading(false);
    }
  };

  // Fetch playlists using fula-client
  // Bucket: playlists, Prefix: user-playlists/
  const fetchPlaylists = async () => {
    if (!user?.id || !user?.email) return;
    setPlaylistsLoading(true);
    setPlaylistsError(null);
    try {
      // Step 1: Derive encryption key bytes for fula-client
      console.log('[Playlists] Deriving encryption key for user:', user.id);
      const keyBytes = await deriveEncryptionKeyBytes(user.provider, user.id, user.email);

      // Step 2: Get JWT token for authentication
      const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
      if (!tokenRes.ok) {
        throw new Error('Failed to get API key');
      }
      const { key: jwtToken } = await tokenRes.json();
      console.log('[Playlists] Got JWT token');

      // Step 3: Create fula-client
      const fulaClient = await getFulaClient(keyBytes, jwtToken, 'https://s3.cloud.fx.land');
      console.log('[Playlists] Created fula-client');

      // Step 4: List playlists from S3 (still use S3 client for listing)
      const s3Client = createS3Client(jwtToken);
      console.log('[Playlists] Listing from S3 - Bucket: playlists, Prefix: user-playlists/');

      try {
        const listCommand = new ListObjectsCommand({
          Bucket: 'playlists',
          Prefix: 'user-playlists/',
        });
        const listResponse = await s3Client.send(listCommand);
        const objects = listResponse.Contents || [];
        console.log('[Playlists] Found', objects.length, 'playlist files');

        if (objects.length === 0) {
          setPlaylistsData([]);
          return;
        }

        // Step 5: Fetch and decrypt each playlist using fula-client
        const decryptedPlaylists: Playlist[] = [];

        for (const obj of objects) {
          if (!obj.Key) continue;

          try {
            console.log('[Playlists] Fetching:', obj.Key);
            // Use fula-client to fetch and decrypt
            const decryptedBytes = await fetchAndDecryptFula(fulaClient, 'playlists', obj.Key);
            const jsonText = new TextDecoder().decode(decryptedBytes);
            console.log('[Playlists] Decrypted:', obj.Key);

            const playlistJson = JSON.parse(jsonText);
            const parsed = parsePlaylists(Array.isArray(playlistJson) ? playlistJson : [playlistJson]);
            decryptedPlaylists.push(...parsed);
          } catch (fetchErr) {
            console.error('[Playlists] Failed to fetch/decrypt', obj.Key, ':', fetchErr);
            // Continue with other playlists
          }
        }

        setPlaylistsData(decryptedPlaylists);
      } catch (s3Err: any) {
        if (s3Err.name === 'NoSuchBucket' || s3Err.$metadata?.httpStatusCode === 404) {
          console.log('[Playlists] Playlists bucket not found');
          setPlaylistsData([]);
          return;
        }
        throw s3Err;
      }
    } catch (err) {
      console.error('[Playlists] Error:', err);
      setPlaylistsError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setPlaylistsLoading(false);
    }
  };

  // ============== FxFiles Functions ==============

  // Helper to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Build breadcrumbs for FxFiles navigation
  const buildFxBreadcrumbs = (bucket: string, prefix: string): { label: string; path: string }[] => {
    const crumbs: { label: string; path: string }[] = [
      { label: t.pins.fxBuckets || 'Buckets', path: '' },
      { label: bucket, path: '/' },
    ];

    if (prefix) {
      const parts = prefix.split('/').filter(Boolean);
      let currentPath = '/';
      for (const part of parts) {
        currentPath += part + '/';
        crumbs.push({ label: part, path: currentPath });
      }
    }

    return crumbs;
  };

  // Fetch user's S3 buckets
  const fetchFxBuckets = async () => {
    if (!user?.id || !user?.email) return;

    setFxFilesLoading(true);
    setFxFilesError(null);

    try {
      const keyBytes = await deriveEncryptionKeyBytes(user.provider, user.id, user.email);

      const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
      if (!tokenRes.ok) {
        throw new Error(t.pins.apiKeyRequired || 'Please create an API key in the API Keys page first.');
      }
      const { key: accessToken } = await tokenRes.json();

      const client = await getFulaClient(keyBytes, accessToken, 'https://s3.cloud.fx.land');
      const buckets = await listFulaBuckets(client);

      setFxBuckets(buckets.map((b: any) => ({
        name: b.name || b.Name,
        creationDate: b.creationDate || b.CreationDate,
      })));

      setFxNavigation({
        currentBucket: null,
        currentPath: '/',
        breadcrumbs: [],
      });
      setFxFiles([]);
    } catch (err) {
      console.error('[FxFiles] Error fetching buckets:', err);
      setFxFilesError(err instanceof Error ? err.message : 'Failed to load buckets');
    } finally {
      setFxFilesLoading(false);
    }
  };

  // Navigate to a bucket or directory
  const navigateToFxDirectory = async (bucket: string, prefix: string = '') => {
    if (!user?.id || !user?.email) return;

    setFxFilesLoading(true);
    setFxFilesError(null);

    try {
      // Debug: Log key derivation inputs for comparison with FxFiles mobile
      console.log('[FxFiles] Key derivation inputs:', {
        userId: user.id,
        userIdLength: user.id.length,
        email: user.email,
        combinedId: `google:${user.id}`,
        salt: `fula-files-v1:${user.email}`,
      });

      const keyBytes = await deriveEncryptionKeyBytes(user.provider, user.id, user.email);
      console.log('[FxFiles] Derived key first 4 bytes:', Array.from(keyBytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' '));

      const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
      if (!tokenRes.ok) throw new Error(t.pins.apiKeyRequired || 'API key required');
      const { key: accessToken } = await tokenRes.json();

      const client = await getFulaClient(keyBytes, accessToken, 'https://s3.cloud.fx.land');

      // List files with decrypted metadata
      // Note: listDecrypted uses HEAD requests on S3 objects
      // For FlatNamespace, metadata comes from object headers, not forest
      const files = await listDecryptedFiles(client, bucket, { prefix: prefix || undefined });

      // DEBUG: Log raw response
      console.log('[FxFiles] Bucket:', bucket, 'Prefix:', prefix);
      console.log('[FxFiles] Raw files from listDecrypted:', files);
      console.log('[FxFiles] Number of files:', files?.length || 0);
      if (files && files.length > 0) {
        console.log('[FxFiles] First file structure:', JSON.stringify(files[0], null, 2));
      }

      // Transform response to FxFileItem format
      const items: FxFileItem[] = [];
      const seenDirs = new Set<string>();

      for (const file of files) {
        // Handle different response formats from listDecrypted:
        // - Encrypted files: originalKey contains decrypted path, storageKey is obfuscated
        // - Unencrypted files: both originalKey and storageKey are the same (raw CID/key)
        // - S3-style response: key or Key property
        const key = file.originalKey || file.storageKey || file.key || file.Key || '';

        // Skip files without a valid key
        if (!key) {
          console.log('[FxFiles] Skipping file with no key:', file);
          continue;
        }

        // Skip .chunks directories and chunk files (internal implementation detail)
        if (key.includes('.chunks')) {
          console.log('[FxFiles] Skipping chunk file:', key);
          continue;
        }

        // Skip internal files (forest index, failed decryptions)
        // Internal files have originalKey === storageKey and start with 'Qm'
        // These are either:
        // 1. Forest index files (encrypted directory structure)
        // 2. Files where metadata decryption failed (isEncrypted: false, originalKey = storageKey)
        const storageKey = file.storageKey || file.key || file.Key || '';
        const isInternalFile = storageKey.startsWith('Qm') &&
          (file.originalKey === storageKey || !file.originalKey || file.originalKey.startsWith('Qm'));
        if (isInternalFile && !file.isEncrypted) {
          console.log('[FxFiles] Skipping internal/unresolved file:', key);
          continue;
        }

        const relativePath = prefix ? key.replace(prefix, '') : key;

        // Check if this is a directory (has more path segments)
        const segments = relativePath.split('/').filter(Boolean);

        // DEBUG: Log each file processing
        console.log('[FxFiles] Processing file:', {
          originalKey: file.originalKey,
          storageKey: file.storageKey,
          key,
          relativePath,
          segments,
          segmentsLength: segments.length,
          isEncrypted: file.isEncrypted
        });

        if (segments.length > 1) {
          // This is inside a subdirectory - add the subdirectory if not seen
          const dirName = segments[0];
          if (!seenDirs.has(dirName)) {
            seenDirs.add(dirName);
            items.push({
              key: prefix + dirName + '/',
              name: dirName,
              isDirectory: true,
              path: prefix + dirName + '/',
            });
          }
        } else if (segments.length === 1) {
          // This is a file in the current directory
          // For encrypted files, originalKey should have the real filename
          // For unencrypted files, use the storageKey/CID as name
          const fileName = file.originalName || file.name || segments[0];
          items.push({
            key: file.storageKey || key,  // Use storageKey for downloads
            name: fileName,
            size: file.size || file.Size,
            lastModified: file.lastModified || file.LastModified,
            isDirectory: false,
            path: file.originalKey || key,  // Use originalKey for fula-client path
          });
        } else if (segments.length === 0 && key) {
          // File at root level with just a CID/key (no path structure)
          const fileName = file.originalName || file.name || key;
          items.push({
            key: file.storageKey || key,
            name: fileName,
            size: file.size || file.Size,
            lastModified: file.lastModified || file.LastModified,
            isDirectory: false,
            path: file.originalKey || key,
          });
        }
      }

      // Sort: directories first, then files alphabetically
      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      setFxFiles(items);
      setFxFilesPage(1); // Reset to first page on navigation

      // Update navigation state
      const breadcrumbs = buildFxBreadcrumbs(bucket, prefix);
      setFxNavigation({
        currentBucket: bucket,
        currentPath: prefix || '/',
        breadcrumbs,
      });
    } catch (err) {
      console.error('[FxFiles] Error navigating:', err);
      setFxFilesError(err instanceof Error ? err.message : 'Failed to load directory');
    } finally {
      setFxFilesLoading(false);
    }
  };

  // Download and decrypt a file
  const downloadFxFile = async (file: FxFileItem) => {
    if (!user?.id || !user?.email || !fxNavigation.currentBucket) return;

    setFxDownloading(prev => new Set(prev).add(file.key));

    try {
      const keyBytes = await deriveEncryptionKeyBytes(user.provider, user.id, user.email);

      const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
      if (!tokenRes.ok) throw new Error(t.pins.apiKeyRequired || 'API key required');
      const { key: accessToken } = await tokenRes.json();

      const client = await getFulaClient(keyBytes, accessToken, 'https://s3.cloud.fx.land');

      // Fetch using storage key (CID) - fula-client returns raw S3 data
      // file.key contains the storageKey (obfuscated CID) which is needed for fetching
      console.log('[FxFiles] Downloading file:', { bucket: fxNavigation.currentBucket, storageKey: file.key });
      const rawData = await fetchAndDecryptByStorageKey(client, fxNavigation.currentBucket, file.key);

      // Check if this is a JSON envelope that needs manual decryption
      // fula-client WASM does NOT decrypt the file - it returns the JSON envelope
      let decryptedData: Uint8Array;
      if (isJsonEnvelope(rawData)) {
        console.log('[FxFiles] Data is JSON envelope, performing manual decryption...');

        // Parse envelope to check version
        const { version, envelope } = parseEnvelope(rawData);
        console.log('[FxFiles] Envelope version:', version, 'Fields:', Object.keys(envelope).join(', '));

        if (isChunkedEnvelopeV2(envelope)) {
          // Version 2 chunked file - need to fetch and decrypt each chunk
          console.log(`[FxFiles] Chunked file v2: ${envelope.chunkCount} chunks, chunkSize: ${envelope.chunkSize}`);

          // Create chunk fetcher that gets chunk data from S3
          const fetchChunk = async (chunkIndex: number): Promise<Uint8Array> => {
            const chunkKey = `${file.key}.chunks/${chunkIndex.toString().padStart(8, '0')}`;
            console.log(`[FxFiles] Fetching chunk ${chunkIndex}: ${chunkKey}`);
            const chunkData = await fetchAndDecryptByStorageKey(client, fxNavigation.currentBucket!, chunkKey);
            return chunkData;
          };

          decryptedData = await decryptChunkedEnvelopeV2(envelope, keyBytes, fetchChunk);
        } else {
          // Version 1 single-block envelope
          decryptedData = await decryptEnvelope(rawData, keyBytes);
        }
      } else {
        // Already decrypted or unencrypted file
        decryptedData = rawData;
      }

      // Detect MIME type
      const mimeType = detectMimeType(decryptedData);
      const ext = getExtensionFromMimeType(mimeType);
      const filename = file.name.includes('.') ? file.name : `${file.name}${ext}`;

      // Trigger download
      downloadBlob(decryptedData, filename, mimeType);
    } catch (err) {
      console.error('[FxFiles] Download failed:', err);
      setFxFilesError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setFxDownloading(prev => {
        const next = new Set(prev);
        next.delete(file.key);
        return next;
      });
    }
  };

  // Preview a file
  const previewFxFile = async (file: FxFileItem) => {
    if (!user?.id || !user?.email || !fxNavigation.currentBucket) return;

    setFxDownloading(prev => new Set(prev).add(file.key));

    try {
      const keyBytes = await deriveEncryptionKeyBytes(user.provider, user.id, user.email);

      const tokenRes = await fetch('/api/keys/active', { credentials: 'include' });
      if (!tokenRes.ok) throw new Error(t.pins.apiKeyRequired || 'API key required');
      const { key: accessToken } = await tokenRes.json();

      const client = await getFulaClient(keyBytes, accessToken, 'https://s3.cloud.fx.land');

      // Fetch using storage key (CID) - fula-client returns raw S3 data
      console.log('[FxFiles] Previewing file:', { bucket: fxNavigation.currentBucket, storageKey: file.key });
      const rawData = await fetchAndDecryptByStorageKey(client, fxNavigation.currentBucket, file.key);

      // Debug: log raw data info
      console.log('[FxFiles] Raw data size:', rawData.length);
      console.log('[FxFiles] Raw data (first 32 bytes):', Array.from(rawData.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));

      // Check if this is a JSON envelope that needs manual decryption
      // fula-client WASM does NOT decrypt the file - it returns the JSON envelope
      let decryptedData: Uint8Array;
      if (isJsonEnvelope(rawData)) {
        console.log('[FxFiles] Data is JSON envelope, performing manual decryption...');

        // Parse envelope to check version
        const { version, envelope } = parseEnvelope(rawData);
        console.log('[FxFiles] Envelope version:', version, 'Fields:', Object.keys(envelope).join(', '));

        if (isChunkedEnvelopeV2(envelope)) {
          // Version 2 chunked file - need to fetch and decrypt each chunk
          console.log(`[FxFiles] Chunked file v2: ${envelope.chunkCount} chunks, chunkSize: ${envelope.chunkSize}`);

          // Create chunk fetcher that gets chunk data from S3
          const fetchChunk = async (chunkIndex: number): Promise<Uint8Array> => {
            const chunkKey = `${file.key}.chunks/${chunkIndex.toString().padStart(8, '0')}`;
            console.log(`[FxFiles] Fetching chunk ${chunkIndex}: ${chunkKey}`);
            const chunkData = await fetchAndDecryptByStorageKey(client, fxNavigation.currentBucket!, chunkKey);
            return chunkData;
          };

          decryptedData = await decryptChunkedEnvelopeV2(envelope, keyBytes, fetchChunk);
        } else {
          // Version 1 single-block envelope
          decryptedData = await decryptEnvelope(rawData, keyBytes);
        }

        console.log('[FxFiles] Decrypted data size:', decryptedData.length);
        console.log('[FxFiles] Decrypted data (first 32 bytes):', Array.from(decryptedData.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      } else {
        // Already decrypted or unencrypted file
        decryptedData = rawData;
      }

      const mimeType = detectMimeType(decryptedData);
      console.log('[FxFiles] Detected MIME type:', mimeType);

      // Check if previewable
      const previewableMimes = ['image/', 'video/', 'audio/', 'application/pdf', 'text/'];
      const isPreviewable = previewableMimes.some(m => mimeType.startsWith(m));

      if (!isPreviewable) {
        // Not previewable, download instead
        const ext = getExtensionFromMimeType(mimeType);
        const filename = file.name.includes('.') ? file.name : `${file.name}${ext}`;
        downloadBlob(decryptedData, filename, mimeType);
        return;
      }

      // Create blob URL for preview
      const blob = new Blob([decryptedData], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      setFxPreviewData({ file, blobUrl, mimeType });
    } catch (err) {
      console.error('[FxFiles] Preview failed:', err);
      setFxFilesError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setFxDownloading(prev => {
        const next = new Set(prev);
        next.delete(file.key);
        return next;
      });
    }
  };

  // Close preview modal
  const closeFxPreview = () => {
    if (fxPreviewData) {
      URL.revokeObjectURL(fxPreviewData.blobUrl);
      setFxPreviewData(null);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchPins();
  };

  const clearSearch = () => {
    setSearchQuery('');
    setPage(1);
  };

  const toggleSelectPin = (requestId: string) => {
    setSelectedPins(prev => {
      const next = new Set(prev);
      if (next.has(requestId)) {
        next.delete(requestId);
      } else {
        next.add(requestId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!data) return;
    if (selectedPins.size === data.pins.length) {
      setSelectedPins(new Set());
    } else {
      setSelectedPins(new Set(data.pins.map(p => p.request_id)));
    }
  };

  const unpinSelected = async () => {
    if (selectedPins.size === 0) return;
    
    const confirmed = window.confirm(
      t.pins.unpinConfirm?.replace('{count}', String(selectedPins.size)) ||
      `Are you sure you want to unpin ${selectedPins.size} item(s)?`
    );
    if (!confirmed) return;

    setUnpinning(true);
    setError(null);
    try {
      const requestIds = Array.from(selectedPins);
      const res = await fetch('/api/pins/bulk-unpin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ requestIds }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to unpin');
      }

      setSelectedPins(new Set());
      await fetchPins();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unpin');
    } finally {
      setUnpinning(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const refreshPin = async (requestId: string) => {
    setRefreshingPins(prev => new Set(prev).add(requestId));
    try {
      const res = await fetch(`/api/pins/${requestId}/refresh`, {
        method: 'POST',
        credentials: 'include'
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to refresh pin');
      }
      // Refresh the pins list to get updated data
      await fetchPins();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh pin');
    } finally {
      setRefreshingPins(prev => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  const fetchPinNodes = async (requestId: string) => {
    setLoadingNodes(prev => new Set(prev).add(requestId));
    try {
      const res = await fetch(`/api/pins/${requestId}/nodes`, {
        credentials: 'include'
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to get pin nodes');
      }
      const data = await res.json();
      setNodesModalData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get pin nodes');
    } finally {
      setLoadingNodes(prev => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  const addPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCid.trim()) return;

    setAdding(true);
    setError(null);
    try {
      // Encrypt pin name client-side if possible (forward-only privacy)
      let pinName = newName.trim();
      if (pinName && user?.email && user?.id) {
        try {
          const key = await deriveEncryptionKey(user.provider as 'google' | 'apple', user.id, user.email);
          const encrypted = await encrypt(new TextEncoder().encode(pinName), key);
          pinName = btoa(String.fromCharCode(...encrypted));
        } catch { /* encryption failed, send plaintext */ }
      }

      const res = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cid: newCid.trim(), name: pinName }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add pin');
      }

      setNewCid('');
      setNewName('');
      setShowAddModal(false);
      setPage(1);
      await fetchPins();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setAdding(false);
    }
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleString();
  };

  const getStatusColor = (status: string): string => {
    switch (status.toLowerCase()) {
      case 'pinned':
        return 'bg-green-100 text-green-800';
      case 'queued':
        return 'bg-yellow-100 text-yellow-800';
      case 'pinning':
        return 'bg-blue-100 text-blue-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // Tab definitions
  const tabs: { id: TabType; label: string; icon: JSX.Element }[] = [
    {
      id: 'fxFiles',
      label: t.pins.tabFxFiles || 'FxFiles',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      ),
    },
    {
      id: 'myPins',
      label: t.pins.tabMyPins || 'My Pins',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
      ),
    },
    {
      id: 'sharedWithMe',
      label: t.pins.tabSharedWithMe || 'Shared with Me',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8m-5 5h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 00.707.293h3.172a1 1 0 00.707-.293l2.414-2.414a1 1 0 01.707-.293H20" />
        </svg>
      ),
    },
    {
      id: 'sharedByMe',
      label: t.pins.tabSharedByMe || 'Shared by Me',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
        </svg>
      ),
    },
    {
      id: 'playlists',
      label: t.pins.tabPlaylists || 'Playlists',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
      ),
    },
  ];

  // Render My Pins Tab Content
  const renderMyPinsTab = () => (
    <>
      {/* Bulk action bar */}
      {selectedPins.size > 0 && (
        <div className="bg-primary-50 border border-primary-200 rounded-xl p-4 flex items-center justify-between">
          <span className="text-primary-700 font-medium">
            {selectedPins.size} {t.pins.selected || 'selected'}
          </span>
          <button
            onClick={unpinSelected}
            disabled={unpinning}
            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {unpinning ? (
              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            )}
            {t.pins.unpin || 'Unpin'}
          </button>
        </div>
      )}

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.pins.searchPlaceholder}
            className="input w-full pl-10"
          />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        {searchQuery && (
          <button type="button" onClick={clearSearch} className="btn-secondary">
            {t.pins.clear}
          </button>
        )}
      </form>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {/* Decryption error message */}
      {decryptionError && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-orange-700 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{decryptionError}</span>
          </div>
          <button onClick={() => setDecryptionError(null)} className="text-orange-500 hover:text-orange-700">✕</button>
        </div>
      )}

      {/* Encryption key setup modal */}
      {showSetupModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b border-gray-100">
              <h2 className="text-xl font-semibold text-gray-900">
                {t.pins.setupDecryption || 'Setup Decryption'}
              </h2>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-lg">
                <svg className="w-6 h-6 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-sm text-blue-800">
                  <p className="font-medium mb-1">{t.pins.decryptionInfo || 'About Decryption'}</p>
                  <p>{t.pins.decryptionInfoText || 'Your encryption key will be derived from your Google account credentials. This key is stored securely in your browser and never sent to our servers.'}</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3 p-4 bg-amber-50 rounded-lg">
                <svg className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="text-sm text-amber-800">
                  <p>{t.pins.decryptionWarning || 'Only files uploaded via the FxFiles app with encryption enabled can be decrypted. Unencrypted files will fail to decrypt.'}</p>
                </div>
              </div>

              {decryptionError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {decryptionError}
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowSetupModal(false)}
                  className="btn-secondary"
                >
                  {t.pins.cancel || 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={setupEncryptionKey}
                  disabled={settingUpKey}
                  className="btn-primary flex items-center gap-2"
                >
                  {settingUpKey ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {t.pins.settingUp || 'Setting up...'}
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                      </svg>
                      {t.pins.enableDecryption || 'Enable Decryption'}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Expand modal */}
      {expandedValue && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setExpandedValue(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-xl font-semibold text-gray-900">{expandedValue.type}</h2>
              <button onClick={() => setExpandedValue(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-6">
              <div className="bg-gray-50 rounded-lg p-4 break-all font-mono text-sm">
                {expandedValue.value}
              </div>
              <button
                onClick={() => copyToClipboard(expandedValue.value)}
                className="mt-4 btn-secondary w-full"
              >
                {copied ? t.pins.copied : t.pins.copy}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add pin modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b border-gray-100">
              <h2 className="text-xl font-semibold text-gray-900">{t.pins.addTitle}</h2>
            </div>
            <form onSubmit={addPin} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t.pins.cidLabel} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newCid}
                  onChange={(e) => setNewCid(e.target.value)}
                  placeholder={t.pins.cidPlaceholder}
                  className="input"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t.pins.cidHelp}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t.pins.nameLabel}
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t.pins.namePlaceholder}
                  className="input"
                />
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn-secondary"
                >
                  {t.pins.cancel}
                </button>
                <button type="submit" disabled={adding || !newCid.trim()} className="btn-primary">
                  {adding ? t.pins.adding : t.pins.add}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cluster nodes modal */}
      {nodesModalData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{t.pins.clusterNodes || 'Cluster Nodes'}</h2>
                <p className="text-sm text-gray-500 mt-1 font-mono truncate max-w-md" title={nodesModalData.cid}>
                  CID: {nodesModalData.cid.substring(0, 20)}...{nodesModalData.cid.substring(nodesModalData.cid.length - 8)}
                </p>
              </div>
              <button
                onClick={() => setNodesModalData(null)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              {(() => {
                const pinnedNodes = nodesModalData.nodes.filter(n => n.status === 'pinned' || n.status === 'pinning' || n.status === 'queued');
                const otherNodes = nodesModalData.nodes.filter(n => n.status !== 'pinned' && n.status !== 'pinning' && n.status !== 'queued');
                const errorCount = otherNodes.filter(n => n.status === 'cluster_error' || n.status === 'pin_error' || n.error).length;

                return (
                  <div className="space-y-4">
                    {/* Summary */}
                    <div className="flex flex-wrap gap-2 pb-4 border-b border-gray-200">
                      <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                        {pinnedNodes.filter(n => n.status === 'pinned').length} nodes storing this content
                      </span>
                      <span className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-sm">
                        {nodesModalData.nodes.length} total cluster nodes
                      </span>
                    </div>

                    {/* Pinned nodes */}
                    {pinnedNodes.length === 0 ? (
                      <div className="text-center py-6 text-gray-500">
                        <p>{t.pins.noPinnedNodes || 'No nodes are currently storing this content.'}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {pinnedNodes.map((node, index) => (
                          <div
                            key={node.peer_id || index}
                            className={`p-3 rounded-lg border ${
                              node.status === 'pinned' ? 'border-green-200 bg-green-50' :
                              node.status === 'pinning' ? 'border-yellow-200 bg-yellow-50' :
                              'border-blue-200 bg-blue-50'
                            }`}
                          >
                            <div className="flex items-center space-x-2">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                node.status === 'pinned' ? 'bg-green-100 text-green-800' :
                                node.status === 'pinning' ? 'bg-yellow-100 text-yellow-800' :
                                'bg-blue-100 text-blue-800'
                              }`}>
                                {node.status}
                              </span>
                              {node.peer_name && (
                                <span className="text-sm font-medium text-gray-900">{node.peer_name}</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 font-mono mt-1 truncate" title={node.peer_id}>
                              {node.peer_id}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Expandable other nodes */}
                    {otherNodes.length > 0 && (
                      <div className="pt-2">
                        <button
                          onClick={() => setShowAllNodes(!showAllNodes)}
                          className="flex items-center text-sm text-gray-500 hover:text-gray-700"
                        >
                          <svg
                            className={`w-4 h-4 mr-1 transition-transform ${showAllNodes ? 'rotate-90' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          {showAllNodes ? 'Hide' : 'Show'} {otherNodes.length} other nodes
                          {errorCount > 0 && ` (${errorCount} with errors)`}
                        </button>

                        {showAllNodes && (
                          <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                            {otherNodes.map((node, index) => (
                              <div
                                key={node.peer_id || index}
                                className={`p-2 rounded text-sm ${
                                  node.error || node.status === 'cluster_error' || node.status === 'pin_error'
                                    ? 'bg-red-50 text-red-700'
                                    : 'bg-gray-50 text-gray-600'
                                }`}
                              >
                                <div className="flex items-center space-x-2">
                                  <span className="text-xs font-medium">{node.status}</span>
                                  <span className="font-mono text-xs truncate" title={node.peer_id}>
                                    {node.peer_id.substring(0, 20)}...
                                  </span>
                                </div>
                                {node.error && (
                                  <p className="text-xs mt-1">{node.error}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="p-4 border-t border-gray-100 flex justify-end">
              <button
                onClick={() => { setNodesModalData(null); setShowAllNodes(false); }}
                className="btn-secondary"
              >
                {t.pins.close || 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pins table */}
      {loading && !data ? (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      ) : data && data.pins.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">📌</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{t.pins.noPins}</h3>
          <p className="text-gray-600 mb-4">{t.pins.noPinsDesc}</p>
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            {t.pins.addFirst}
          </button>
        </div>
      ) : data && (
        <>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full table-fixed">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 sm:px-4 py-2 sm:py-3 w-10">
                      <input
                        type="checkbox"
                        checked={data.pins.length > 0 && selectedPins.size === data.pins.length}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 sm:px-4 py-2 sm:py-3">
                      {t.pins.cid}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 sm:px-4 py-2 sm:py-3 hidden sm:table-cell">
                      {t.pins.name}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 sm:px-4 py-2 sm:py-3 hidden md:table-cell">
                      {t.pins.createdAt}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 sm:px-4 py-2 sm:py-3">
                      {t.pins.status}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 sm:px-4 py-2 sm:py-3 hidden lg:table-cell">
                      {t.pins.requestId}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 sm:px-4 py-2 sm:py-3">
                      {t.pins.actions || 'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.pins.map((pin: Pin) => (
                    <tr key={pin.request_id} className={`hover:bg-gray-50 ${selectedPins.has(pin.request_id) ? 'bg-primary-50' : ''}`}>
                      <td className="px-2 sm:px-4 py-2 sm:py-4">
                        <input
                          type="checkbox"
                          checked={selectedPins.has(pin.request_id)}
                          onChange={() => toggleSelectPin(pin.request_id)}
                          className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                      </td>
                      <td className="px-2 sm:px-4 py-2 sm:py-4">
                        <div className="flex items-center gap-1">
                          <code className="text-xs sm:text-sm font-mono text-gray-700">
                            {pin.cid.slice(0, 8)}...{pin.cid.slice(-4)}
                          </code>
                          <button
                            onClick={() => setExpandedValue({ type: t.pins.cid, value: pin.cid })}
                            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded flex-shrink-0"
                            title="Expand"
                          >
                            <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                          </button>
                        </div>
                      </td>
                      <td className="px-2 sm:px-4 py-2 sm:py-4 text-sm text-gray-600 hidden sm:table-cell max-w-[120px] truncate">
                        {(decryptedPinNames[pin.request_id] || pin.name) || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-2 sm:px-4 py-2 sm:py-4 text-sm text-gray-600 hidden md:table-cell whitespace-nowrap">
                        {formatDate(pin.created_at)}
                      </td>
                      <td className="px-2 sm:px-4 py-2 sm:py-4">
                        <span className={`inline-flex px-1.5 sm:px-2 py-0.5 sm:py-1 text-xs font-medium rounded-full ${getStatusColor(pin.status)}`}>
                          {pin.status}
                        </span>
                      </td>
                      <td className="px-2 sm:px-4 py-2 sm:py-4 hidden lg:table-cell">
                        <div className="flex items-center gap-1">
                          <code className="text-xs sm:text-sm text-gray-500 font-mono">
                            {pin.request_id.slice(0, 8)}...
                          </code>
                          <button
                            onClick={() => setExpandedValue({ type: t.pins.requestId, value: pin.request_id })}
                            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded flex-shrink-0"
                            title="Expand"
                          >
                            <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                          </button>
                        </div>
                      </td>
                      <td className="px-2 sm:px-4 py-2 sm:py-4">
                        <div className="flex items-center gap-0.5 sm:gap-1 min-w-0">
                          {/* Download Decrypted button */}
                          <button
                            onClick={() => downloadDecrypted(pin)}
                            disabled={decryptingPins.has(pin.request_id)}
                            className="p-1.5 sm:p-2 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
                            title={t.pins.downloadDecrypted || 'Download Decrypted'}
                          >
                            {decryptingPins.has(pin.request_id) ? (
                              <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            ) : (
                              <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                              </svg>
                            )}
                          </button>
                          {/* Refresh button */}
                          <button
                            onClick={() => refreshPin(pin.request_id)}
                            disabled={refreshingPins.has(pin.request_id)}
                            className="p-1.5 sm:p-2 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                            title={t.pins.refresh || 'Refresh status'}
                          >
                            <svg
                              className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${refreshingPins.has(pin.request_id) ? 'animate-spin' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </button>
                          {/* View Nodes button */}
                          <button
                            onClick={() => fetchPinNodes(pin.request_id)}
                            disabled={loadingNodes.has(pin.request_id)}
                            className="p-1.5 sm:p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                            title={t.pins.viewNodes || 'View cluster nodes'}
                          >
                            {loadingNodes.has(pin.request_id) ? (
                              <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            ) : (
                              <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex justify-between items-center">
              <p className="text-sm text-gray-600">
                {t.pins.page} {data.page} {t.pins.of} {data.totalPages}
              </p>
              <div className="flex space-x-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="btn-secondary disabled:opacity-50"
                >
                  {t.pins.previous}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="btn-secondary disabled:opacity-50"
                >
                  {t.pins.next}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );

  // Render Shared With Me Tab Content
  const renderSharedWithMeTab = () => {
    if (sharedWithMeLoading) {
      return (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      );
    }

    if (sharedWithMeError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700">
          {sharedWithMeError}
        </div>
      );
    }

    if (!sharedWithMeData || sharedWithMeData.shares.length === 0) {
      return (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">📥</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {t.pins.noSharedWithMe || 'No shared items'}
          </h3>
          <p className="text-gray-600">
            {t.pins.noSharedWithMeDesc || 'Items shared with you will appear here'}
          </p>
        </div>
      );
    }

    return (
      <>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.pins.cid}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden sm:table-cell">
                    {t.pins.name}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden md:table-cell">
                    {t.pins.sharedBy || 'Shared By'}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden lg:table-cell">
                    {t.pins.sharedOn || 'Shared On'}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.pins.permissions || 'Permissions'}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.pins.actions || 'Actions'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sharedWithMeData.shares.map((item, idx) => (
                  <tr key={`${item.cid}-${idx}`} className="hover:bg-gray-50">
                    <td className="px-4 py-4">
                      <code className="text-sm font-mono text-gray-700">
                        {item.cid.slice(0, 12)}...{item.cid.slice(-6)}
                      </code>
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 hidden sm:table-cell">
                      {item.name || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 hidden md:table-cell">
                      {item.sharedBy}
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 hidden lg:table-cell">
                      {formatDate(item.sharedAt)}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-1">
                        {item.permissions.map((perm) => (
                          <span key={perm} className="inline-flex px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800">
                            {perm}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <a
                        href={`/view/${item.cid}`}
                        className="p-2 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-lg transition-colors inline-block"
                        title={t.pins.viewContent || 'View content'}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination for Shared With Me */}
        {sharedWithMeData.totalPages > 1 && (
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-600">
              {t.pins.page} {sharedWithMeData.page} {t.pins.of} {sharedWithMeData.totalPages}
            </p>
            <div className="flex space-x-2">
              <button
                onClick={() => setSharedWithMePage((p) => Math.max(1, p - 1))}
                disabled={sharedWithMePage === 1}
                className="btn-secondary disabled:opacity-50"
              >
                {t.pins.previous}
              </button>
              <button
                onClick={() => setSharedWithMePage((p) => Math.min(sharedWithMeData.totalPages, p + 1))}
                disabled={sharedWithMePage === sharedWithMeData.totalPages}
                className="btn-secondary disabled:opacity-50"
              >
                {t.pins.next}
              </button>
            </div>
          </div>
        )}
      </>
    );
  };

  // Render Shared By Me Tab Content
  const renderSharedByMeTab = () => {
    if (sharedByMeLoading) {
      return (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      );
    }

    if (sharedByMeError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700">
          {sharedByMeError}
        </div>
      );
    }

    if (sharedByMeNeedsKey) {
      return (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">🔐</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {t.pins.setupDecryptionRequired || 'Decryption Setup Required'}
          </h3>
          <p className="text-gray-600 mb-4">
            {t.pins.setupDecryptionDesc || 'To view your shared items, you need to set up decryption first.'}
          </p>
          <p className="text-gray-500 text-sm">
            {t.pins.setupDecryptionHint || 'Go to the "My Pins" tab and click "Download Decrypted" on any file to set up your encryption key.'}
          </p>
        </div>
      );
    }

    if (sharedByMeData.length === 0) {
      return (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">📤</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {t.pins.noSharedByMe || 'No shared items'}
          </h3>
          <p className="text-gray-600">
            {t.pins.noSharedByMeDesc || 'Items you share will appear here'}
          </p>
        </div>
      );
    }

    // Pagination for shared by me
    const startIdx = (sharedByMePage - 1) * ITEMS_PER_PAGE;
    const endIdx = startIdx + ITEMS_PER_PAGE;
    const paginatedShares = sharedByMeData.slice(startIdx, endIdx);
    const totalPages = Math.ceil(sharedByMeData.length / ITEMS_PER_PAGE);

    return (
      <>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.pins.cid}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden sm:table-cell">
                    {t.pins.name}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden md:table-cell">
                    {t.pins.sharedWith || 'Shared With'}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden lg:table-cell">
                    {t.pins.expiresOn || 'Expires'}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.pins.shareType || 'Type'}
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                    {t.pins.actions || 'Actions'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {paginatedShares.map((share, idx) => (
                  <tr key={`${share.cid}-${idx}`} className="hover:bg-gray-50">
                    <td className="px-4 py-4">
                      <code className="text-sm font-mono text-gray-700">
                        {share.cid.slice(0, 12)}...{share.cid.slice(-6)}
                      </code>
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 hidden sm:table-cell">
                      {share.name || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 hidden md:table-cell">
                      {share.recipientEmail || share.recipientDid?.slice(0, 16) + '...' || t.pins.publicLink || 'Public link'}
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-600 hidden lg:table-cell">
                      {share.expiresAt ? formatDate(share.expiresAt) : (t.pins.noExpiry || 'No expiry')}
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                        share.isPasswordProtected ? 'bg-purple-100 text-purple-800' :
                        share.recipientDid ? 'bg-green-100 text-green-800' :
                        'bg-blue-100 text-blue-800'
                      }`}>
                        {share.isPasswordProtected ? (t.pins.passwordProtected || 'Password') :
                         share.recipientDid ? (t.pins.directShare || 'Direct') :
                         (t.pins.publicLink || 'Public')}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <button
                        onClick={() => {
                          const shareUrl = share.shareUrl || `${window.location.origin}/view/${share.cid}`;
                          navigator.clipboard.writeText(shareUrl);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        className="p-2 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-lg transition-colors"
                        title={t.pins.copyLink || 'Copy link'}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination for Shared By Me */}
        {totalPages > 1 && (
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-600">
              {t.pins.page} {sharedByMePage} {t.pins.of} {totalPages}
            </p>
            <div className="flex space-x-2">
              <button
                onClick={() => setSharedByMePage((p) => Math.max(1, p - 1))}
                disabled={sharedByMePage === 1}
                className="btn-secondary disabled:opacity-50"
              >
                {t.pins.previous}
              </button>
              <button
                onClick={() => setSharedByMePage((p) => Math.min(totalPages, p + 1))}
                disabled={sharedByMePage === totalPages}
                className="btn-secondary disabled:opacity-50"
              >
                {t.pins.next}
              </button>
            </div>
          </div>
        )}
      </>
    );
  };

  // Render Playlists Tab Content
  const renderPlaylistsTab = () => {
    if (playlistsLoading) {
      return (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      );
    }

    if (playlistsError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700">
          {playlistsError}
        </div>
      );
    }

    if (playlistsData.length === 0) {
      return (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">🎵</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {t.pins.noPlaylists || 'No playlists'}
          </h3>
          <p className="text-gray-600">
            {t.pins.noPlaylistsDesc || 'Your playlists will appear here'}
          </p>
        </div>
      );
    }

    // Pagination for playlists
    const startIdx = (playlistsPage - 1) * ITEMS_PER_PAGE;
    const endIdx = startIdx + ITEMS_PER_PAGE;
    const paginatedPlaylists = playlistsData.slice(startIdx, endIdx);
    const totalPages = Math.ceil(playlistsData.length / ITEMS_PER_PAGE);

    return (
      <>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {paginatedPlaylists.map((playlist, idx) => (
            <div key={`${playlist.id}-${idx}`} className="card hover:shadow-lg transition-shadow">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-gradient-to-br from-primary-400 to-primary-600 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">{playlist.name}</h3>
                  <p className="text-sm text-gray-500">
                    {playlist.tracks.length} {t.pins.tracks || 'tracks'}
                  </p>
                  {playlist.description && (
                    <p className="text-sm text-gray-600 mt-1 line-clamp-2">{playlist.description}</p>
                  )}
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-gray-100">
                <div className="flex items-center justify-between text-sm text-gray-500">
                  <span>{t.pins.createdAt}: {formatDate(playlist.createdAt)}</span>
                  <button
                    onClick={() => {
                      // Play or view playlist functionality
                    }}
                    className="p-2 text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                    title={t.pins.playPlaylist || 'Play playlist'}
                  >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Pagination for Playlists */}
        {totalPages > 1 && (
          <div className="flex justify-between items-center mt-6">
            <p className="text-sm text-gray-600">
              {t.pins.page} {playlistsPage} {t.pins.of} {totalPages}
            </p>
            <div className="flex space-x-2">
              <button
                onClick={() => setPlaylistsPage((p) => Math.max(1, p - 1))}
                disabled={playlistsPage === 1}
                className="btn-secondary disabled:opacity-50"
              >
                {t.pins.previous}
              </button>
              <button
                onClick={() => setPlaylistsPage((p) => Math.min(totalPages, p + 1))}
                disabled={playlistsPage === totalPages}
                className="btn-secondary disabled:opacity-50"
              >
                {t.pins.next}
              </button>
            </div>
          </div>
        )}
      </>
    );
  };

  // Render FxFiles Tab Content
  const renderFxFilesTab = () => {
    // Loading state
    if (fxFilesLoading) {
      return (
        <div className="card">
          <div className="animate-pulse space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      );
    }

    // Error state
    if (fxFilesError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 flex justify-between items-center">
          <span>{fxFilesError}</span>
          <button onClick={() => setFxFilesError(null)} className="text-red-500 hover:text-red-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      );
    }

    // Bucket list view (no bucket selected)
    if (!fxNavigation.currentBucket) {
      if (fxBuckets.length === 0) {
        return (
          <div className="card text-center py-12">
            <div className="text-5xl mb-4">
              <svg className="w-16 h-16 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {t.pins.noBuckets || 'No Buckets Found'}
            </h3>
            <p className="text-gray-600">
              {t.pins.noBucketsDesc || 'Upload files using FxFiles app to see them here'}
            </p>
          </div>
        );
      }

      return (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {fxBuckets.map((bucket) => (
            <div
              key={bucket.name}
              onClick={() => navigateToFxDirectory(bucket.name, '')}
              className="card hover:shadow-lg transition-shadow cursor-pointer"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                  <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{bucket.name}</h3>
                  {bucket.creationDate && (
                    <p className="text-sm text-gray-500">
                      {t.pins.createdAt}: {formatDate(bucket.creationDate)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    }

    // File browser view
    return (
      <div className="space-y-4">
        {/* Breadcrumb Navigation with Refresh Button */}
        <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm flex-wrap">
            {fxNavigation.breadcrumbs.map((crumb, idx) => (
            <span key={idx} className="flex items-center">
              {idx > 0 && <span className="text-gray-400 mx-2">/</span>}
              <button
                onClick={() => {
                  if (crumb.path === '') {
                    // Go back to bucket list
                    fetchFxBuckets();
                  } else {
                    navigateToFxDirectory(fxNavigation.currentBucket!, crumb.path === '/' ? '' : crumb.path);
                  }
                }}
                className={`hover:text-primary-600 ${
                  idx === fxNavigation.breadcrumbs.length - 1
                    ? 'text-gray-900 font-medium'
                    : 'text-gray-500 hover:underline'
                }`}
              >
                {crumb.label}
              </button>
            </span>
          ))}
          </div>
          {/* Refresh Button */}
          <button
            onClick={() => {
              if (fxNavigation.currentBucket) {
                navigateToFxDirectory(fxNavigation.currentBucket, fxNavigation.currentPath === '/' ? '' : fxNavigation.currentPath);
              } else {
                fetchFxBuckets();
              }
            }}
            disabled={fxFilesLoading}
            className="p-2 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
            title={t.pins.refresh || 'Refresh'}
          >
            <svg
              className={`w-5 h-5 ${fxFilesLoading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>

        {/* File/Folder Table */}
        {fxFiles.length === 0 ? (
          <div className="card text-center py-12">
            <div className="text-5xl mb-4">
              <svg className="w-16 h-16 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {t.pins.emptyFolder || 'Empty Folder'}
            </h3>
          </div>
        ) : (
          <div className="card overflow-hidden">
            {/* File count and pagination info */}
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex justify-between items-center text-sm text-gray-600">
              <span>
                {fxFiles.length} {fxFiles.length === 1 ? (t.pins.file || 'file') : (t.pins.files || 'files')}
                {fxFiles.length > FX_FILES_PER_PAGE && (
                  <span className="ml-2">
                    (showing {((fxFilesPage - 1) * FX_FILES_PER_PAGE) + 1}-{Math.min(fxFilesPage * FX_FILES_PER_PAGE, fxFiles.length)})
                  </span>
                )}
              </span>
              {fxFiles.length > FX_FILES_PER_PAGE && (
                <span>
                  Page {fxFilesPage} of {Math.ceil(fxFiles.length / FX_FILES_PER_PAGE)}
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.pins.name}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden sm:table-cell">
                      {t.pins.size || 'Size'}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 hidden md:table-cell">
                      {t.pins.lastModified || 'Modified'}
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">
                      {t.pins.actions || 'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {fxFiles.slice((fxFilesPage - 1) * FX_FILES_PER_PAGE, fxFilesPage * FX_FILES_PER_PAGE).map((item) => (
                    <tr key={item.key} className="hover:bg-gray-50">
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-3">
                          {/* Icon */}
                          {item.isDirectory ? (
                            <svg className="w-5 h-5 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                            </svg>
                          ) : (
                            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                          )}
                          {/* Name (clickable for directories) */}
                          {item.isDirectory ? (
                            <button
                              onClick={() => navigateToFxDirectory(fxNavigation.currentBucket!, item.path)}
                              className="text-primary-600 hover:text-primary-800 font-medium hover:underline"
                            >
                              {item.name}
                            </button>
                          ) : (
                            <span className="text-gray-900">{item.name}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-500 hidden sm:table-cell">
                        {item.isDirectory ? '--' : formatFileSize(item.size || 0)}
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-500 hidden md:table-cell">
                        {item.lastModified ? formatDate(item.lastModified) : '--'}
                      </td>
                      <td className="px-4 py-4">
                        {!item.isDirectory && (
                          <div className="flex items-center gap-1">
                            {/* Preview button */}
                            <button
                              onClick={() => previewFxFile(item)}
                              disabled={fxDownloading.has(item.key)}
                              className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                              title={t.pins.preview || 'Preview'}
                            >
                              {fxDownloading.has(item.key) ? (
                                <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                              )}
                            </button>
                            {/* Download button */}
                            <button
                              onClick={() => downloadFxFile(item)}
                              disabled={fxDownloading.has(item.key)}
                              className="p-2 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
                              title={t.pins.download || 'Download'}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination Controls */}
              {fxFiles.length > FX_FILES_PER_PAGE && (
                <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
                  <div className="text-sm text-gray-600">
                    Showing {((fxFilesPage - 1) * FX_FILES_PER_PAGE) + 1} to {Math.min(fxFilesPage * FX_FILES_PER_PAGE, fxFiles.length)} of {fxFiles.length} files
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setFxFilesPage(p => Math.max(1, p - 1))}
                      disabled={fxFilesPage === 1}
                      className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-gray-600">
                      Page {fxFilesPage} of {Math.ceil(fxFiles.length / FX_FILES_PER_PAGE)}
                    </span>
                    <button
                      onClick={() => setFxFilesPage(p => Math.min(Math.ceil(fxFiles.length / FX_FILES_PER_PAGE), p + 1))}
                      disabled={fxFilesPage >= Math.ceil(fxFiles.length / FX_FILES_PER_PAGE)}
                      className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Render FxFiles Preview Modal
  const renderFxPreviewModal = () => {
    if (!fxPreviewData) return null;

    const { file, blobUrl, mimeType } = fxPreviewData;

    return (
      <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4" onClick={closeFxPreview}>
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="p-4 border-b border-gray-100 flex justify-between items-center">
            <h2 className="text-lg font-semibold text-gray-900 truncate">{file.name}</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => downloadFxFile(file)}
                className="btn-secondary flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {t.pins.download || 'Download'}
              </button>
              <button onClick={closeFxPreview} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-gray-50">
            {mimeType.startsWith('image/') && (
              <img src={blobUrl} alt={file.name} className="max-w-full max-h-full object-contain" />
            )}
            {mimeType.startsWith('video/') && (
              <video src={blobUrl} controls className="max-w-full max-h-full" />
            )}
            {mimeType.startsWith('audio/') && (
              <div className="w-full max-w-md">
                <audio src={blobUrl} controls className="w-full" />
              </div>
            )}
            {mimeType === 'application/pdf' && (
              <iframe src={blobUrl} className="w-full h-full min-h-[500px]" title={file.name} />
            )}
            {mimeType.startsWith('text/') && (
              <iframe src={blobUrl} className="w-full h-full min-h-[500px] bg-white" title={file.name} />
            )}
          </div>
        </div>
      </div>
    );
  };

  // Main return with tabbed interface
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.pins.title}</h1>
          <p className="text-gray-600 mt-1">
            {activeTab === 'myPins' && data ? `${data.total} ${t.pins.totalPins}` :
             activeTab === 'sharedWithMe' && sharedWithMeData ? `${sharedWithMeData.total} ${t.pins.items || 'items'}` :
             activeTab === 'sharedByMe' ? `${sharedByMeData.length} ${t.pins.items || 'items'}` :
             activeTab === 'playlists' ? `${playlistsData.length} ${t.pins.playlists || 'playlists'}` :
             activeTab === 'fxFiles' ? `${fxNavigation.currentBucket ? fxFiles.length + ' ' + (t.pins.items || 'items') : fxBuckets.length + ' ' + (t.pins.buckets || 'buckets')}` :
             t.common.loading}
          </p>
        </div>
        {activeTab === 'myPins' && (
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            + {t.pins.addPin}
          </button>
        )}
      </div>

      {/* Tab navigation */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-4 overflow-x-auto" aria-label="Tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex items-center gap-2 py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-colors
                ${activeTab === tab.id
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="space-y-6">
        {activeTab === 'myPins' && renderMyPinsTab()}
        {activeTab === 'sharedWithMe' && renderSharedWithMeTab()}
        {activeTab === 'sharedByMe' && renderSharedByMeTab()}
        {activeTab === 'playlists' && renderPlaylistsTab()}
        {activeTab === 'fxFiles' && renderFxFilesTab()}
      </div>

      {/* FxFiles Preview Modal */}
      {renderFxPreviewModal()}

      {/* Copied toast notification */}
      {copied && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-lg shadow-lg z-50">
          {t.pins.copied}
        </div>
      )}
    </div>
  );
}
