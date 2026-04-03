import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import {
  parseCollabUrl,
  decryptManifestPayload,
  updateCollabManifest,
  type CollaborationManifest,
  type CollaborationPayload,
  type CollaborationFile,
} from '../services/sharingService';
import { createShareClient, acceptShareToken, decryptWithAcceptedShare } from '../services/fulaClientService';
import { downloadBlob } from '../services/encryptionService';
import CollabUploader from '../components/CollabUploader';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function getFileIcon(contentType?: string): string {
  if (!contentType) return '\u{1F4C4}';
  if (contentType.startsWith('image/')) return '\u{1F5BC}';
  if (contentType.startsWith('video/')) return '\u{1F3AC}';
  if (contentType.startsWith('audio/')) return '\u{1F3B5}';
  if (contentType.includes('pdf')) return '\u{1F4D1}';
  if (contentType.startsWith('text/')) return '\u{1F4DD}';
  return '\u{1F4C4}';
}

interface CollabState {
  loading: boolean;
  error: string | null;
  payload: CollaborationPayload | null;
  manifest: CollaborationManifest | null;
  downloading: string | null; // fileId being downloaded
}

export default function Collab() {
  const { groupId } = useParams<{ groupId: string }>();

  const [state, setState] = useState<CollabState>({
    loading: true,
    error: null,
    payload: null,
    manifest: null,
    downloading: null,
  });
  const [currentPath, setCurrentPath] = useState<string>('');
  const manifest = state.manifest;

  const loadManifest = useCallback(async () => {
    try {
      const parsed = parseCollabUrl();
      if (!parsed) {
        setState(s => ({ ...s, loading: false, error: 'Invalid collaboration link' }));
        return;
      }

      setState(s => ({ ...s, payload: parsed.payload }));

      let manifest: CollaborationManifest | null = null;

      // Try server-synced manifest first (always up-to-date, avoids stale CID issue)
      try {
        const groupId = parsed.payload.g;
        const syncResp = await fetch(`/api/collab/${groupId}/manifest-sync`);
        if (syncResp.ok) {
          const result = await syncResp.json();
          if (result.encryptedManifest) {
            // Encrypted manifest — decrypt client-side with link secret key
            const linkSecret = Uint8Array.from(atob(parsed.payload.sk), c => c.charCodeAt(0));
            manifest = await decryptManifestPayload(
              result.encryptedManifest, linkSecret, groupId
            ) as CollaborationManifest;
            console.log('[Collab] Loaded encrypted manifest from server sync');
          } else if (result.data) {
            // Legacy plaintext manifest
            manifest = JSON.parse(result.data) as CollaborationManifest;
            console.log('[Collab] Loaded plaintext manifest from server sync');
          }
        }
      } catch (syncErr) {
        console.warn('[Collab] Server sync fetch failed, falling back to fula:', syncErr);
      }

      // Fallback: decrypt from fula using the embedded share token
      if (!manifest) {
        const linkSecret = Uint8Array.from(atob(parsed.payload.sk), c => c.charCodeAt(0));
        const proxyEndpoint = `${window.location.origin}/api/share/v2/fetch`;
        const client = await createShareClient(linkSecret, proxyEndpoint);
        const accepted = await acceptShareToken(client, parsed.payload.t);

        const tokenData = JSON.parse(parsed.payload.t);
        const manifestCid = tokenData.path_scope;

        const decryptedBytes = await decryptWithAcceptedShare(client, parsed.payload.b, manifestCid, accepted);
        manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(decryptedBytes))) as CollaborationManifest;
        console.log('[Collab] Loaded manifest from fula (fallback)');
      }

      setState(s => ({
        ...s,
        loading: false,
        manifest,
      }));
    } catch (err) {
      console.error('[Collab] Failed to load:', err);
      setState(s => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load collaboration',
      }));
    }
  }, []);

  useEffect(() => {
    loadManifest();
  }, [loadManifest]);

  const handleDownloadFile = useCallback(async (file: CollaborationFile) => {
    if (!state.payload) return;

    setState(s => ({ ...s, downloading: file.id }));
    try {
      // Fetch encrypted file content from server
      // For collab-uploaded files, use the dedicated collab fetch endpoint (uses creator's JWT)
      // For fula-synced files, use the share/v2/fetch endpoint
      const url = file.encType === 'collab'
        ? `/api/collab/${state.payload!.g}/file/${file.id}`
        : `/api/share/v2/fetch/${encodeURIComponent(file.bucket)}/${encodeURIComponent(file.storageKey)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);

      const encrypted = new Uint8Array(await response.arrayBuffer());

      if (file.encType === 'collab') {
        // Decrypt with collaboration key
        const { deriveCollabFileKey, decryptCollabFile } = await import('../services/sharingService');
        const linkSecret = Uint8Array.from(atob(state.payload.sk), c => c.charCodeAt(0));
        const key = await deriveCollabFileKey(linkSecret, file.id);
        const decrypted = await decryptCollabFile(encrypted, key);
        downloadBlob(
          new Uint8Array(decrypted),
          file.fileName,
          file.contentType || 'application/octet-stream'
        );
      } else {
        // fula-encrypted files: use share token for decryption
        if (file.shareTokenJson) {
          const linkSecret = Uint8Array.from(atob(state.payload.sk), c => c.charCodeAt(0));
          const proxyEndpoint = `${window.location.origin}/api/share/v2/fetch`;
          const client = await createShareClient(linkSecret, proxyEndpoint);
          const accepted = await acceptShareToken(client, file.shareTokenJson);
          const decrypted = await decryptWithAcceptedShare(client, file.bucket, file.storageKey, accepted);
          downloadBlob(
            new Uint8Array(decrypted),
            file.fileName,
            file.contentType || 'application/octet-stream'
          );
        } else {
          // Fallback: download encrypted bytes as-is
          downloadBlob(encrypted, file.fileName, file.contentType || 'application/octet-stream');
        }
      }
    } catch (err) {
      console.error('[Collab] Download failed:', err);
      alert(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setState(s => ({ ...s, downloading: null }));
    }
  }, [state.payload]);

  const handleUploadComplete = useCallback(() => {
    // Reload manifest to show new files
    loadManifest();
  }, [loadManifest]);

  const handleCreateFolder = useCallback(async () => {
    if (!manifest || !state.payload) return;

    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();

    if (trimmed.includes('/') || trimmed === '.' || trimmed === '..') {
      alert('Invalid folder name');
      return;
    }

    const newPath = currentPath ? `${currentPath}/${trimmed}` : trimmed;

    // Check for duplicate folder at this level
    const exists = manifest.files.some(
      f => f.contentType === 'application/x-directory' && f.pathScope === newPath
    );
    if (exists) {
      alert('A folder with this name already exists');
      return;
    }

    // Add folder marker to manifest
    const folderMarker: CollaborationFile = {
      id: uuidv4(),
      fileName: '.folder',
      contentType: 'application/x-directory',
      bucket: '',
      storageKey: '',
      pathScope: newPath,
      addedByPublicKey: 'web-collaborator',
      addedAt: new Date().toISOString(),
      fileSize: 0,
      encType: 'collab',
    };

    const updated: CollaborationManifest = {
      ...manifest,
      files: [...manifest.files, folderMarker],
      version: manifest.version + 1,
      updatedAt: new Date().toISOString(),
    };

    try {
      const linkSecret = Uint8Array.from(atob(state.payload.sk), c => c.charCodeAt(0));
      await updateCollabManifest(manifest.id, updated, linkSecret);
      loadManifest();
    } catch (err) {
      console.error('[Collab] Failed to create folder:', err);
      alert('Failed to create folder');
    }
  }, [manifest, state.payload, currentPath, loadManifest]);

  // Compute folders and files at current path
  const { folders, filesAtPath } = useMemo(() => {
    if (!manifest) return { folders: [] as string[], filesAtPath: [] as CollaborationFile[] };

    const folderSet = new Set<string>();
    const files: CollaborationFile[] = [];

    for (const file of manifest.files) {
      // Only collab-uploaded files use pathScope as folder path.
      // Fula files have pathScope as storage key (e.g. "images/bafyabc") — show at root.
      const filePath = (file.encType === 'collab' ? file.pathScope : '') || '';

      if (currentPath === '') {
        // At root
        if (!filePath) {
          // File at root level
          if (file.contentType !== 'application/x-directory') {
            files.push(file);
          }
        } else {
          // File in a subfolder — extract top-level folder name
          const topFolder = filePath.split('/')[0];
          folderSet.add(topFolder);
        }
      } else {
        if (filePath === currentPath && file.contentType !== 'application/x-directory') {
          // File directly at current path
          files.push(file);
        } else if (filePath.startsWith(currentPath + '/')) {
          // File in a deeper subfolder
          const remainder = filePath.slice(currentPath.length + 1);
          const nextSegment = remainder.split('/')[0];
          folderSet.add(nextSegment);
        }
      }
    }

    // Also add explicit folder markers
    for (const file of manifest.files) {
      if (file.contentType === 'application/x-directory' && file.pathScope) {
        const parentPath = file.pathScope.lastIndexOf('/') >= 0
          ? file.pathScope.slice(0, file.pathScope.lastIndexOf('/'))
          : '';
        if (parentPath === currentPath) {
          const folderName = file.pathScope.slice(parentPath ? parentPath.length + 1 : 0);
          if (folderName && !folderName.includes('/')) {
            folderSet.add(folderName);
          }
        }
      }
    }

    return {
      folders: Array.from(folderSet).sort((a, b) => a.localeCompare(b)),
      filesAtPath: files.sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
    };
  }, [manifest, currentPath]);

  // Count items inside a folder (files + subfolders, recursive)
  const countFolderItems = useCallback((folderPath: string): number => {
    if (!manifest) return 0;
    return manifest.files.filter(f => {
      const p = (f.encType === 'collab' ? f.pathScope : '') || '';
      return p === folderPath || p.startsWith(folderPath + '/');
    }).filter(f => f.contentType !== 'application/x-directory').length;
  }, [manifest]);

  // Loading state
  if (state.loading) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: '100vh', gap: '16px',
      }}>
        <div style={{
          width: '40px', height: '40px', border: '4px solid #e2e8f0',
          borderTopColor: '#3b82f6', borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }} />
        <p style={{ color: '#64748b' }}>Loading collaboration...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Error state
  if (state.error) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: '100vh', gap: '16px',
        padding: '24px',
      }}>
        <div style={{ fontSize: '48px' }}>{'\u26A0\uFE0F'}</div>
        <h2 style={{ margin: 0, color: '#1e293b' }}>Error</h2>
        <p style={{ color: '#64748b', textAlign: 'center', maxWidth: '400px' }}>
          {state.error}
        </p>
      </div>
    );
  }

  if (!manifest) return null;

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '24px' }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
        borderRadius: '16px', padding: '24px', color: 'white',
        marginBottom: '24px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <span style={{ fontSize: '28px' }}>{'\u{1F4C1}'}</span>
          <h1 style={{ margin: 0, fontSize: '24px' }}>{manifest.name}</h1>
        </div>
        <p style={{ margin: 0, opacity: 0.9, fontSize: '14px' }}>
          {manifest.files.length} file{manifest.files.length === 1 ? '' : 's'}
          {' \u00B7 '}Shared collaboration space
          {manifest.isRevoked && (
            <span style={{
              background: 'rgba(255,255,255,0.2)', padding: '2px 8px',
              borderRadius: '8px', marginLeft: '8px', fontSize: '12px',
            }}>
              Revoked
            </span>
          )}
        </p>
      </div>

      {/* Breadcrumb navigation */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        marginBottom: '16px', fontSize: '14px', flexWrap: 'wrap',
      }}>
        <span
          onClick={() => setCurrentPath('')}
          style={{
            cursor: 'pointer', color: currentPath ? '#3b82f6' : '#1e293b',
            fontWeight: currentPath ? 400 : 600,
          }}
        >
          {'\u{1F3E0}'} Root
        </span>
        {currentPath && currentPath.split('/').map((segment, i, arr) => {
          const path = arr.slice(0, i + 1).join('/');
          const isLast = i === arr.length - 1;
          return (
            <span key={path} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ color: '#94a3b8' }}>/</span>
              <span
                onClick={() => !isLast && setCurrentPath(path)}
                style={{
                  cursor: isLast ? 'default' : 'pointer',
                  color: isLast ? '#1e293b' : '#3b82f6',
                  fontWeight: isLast ? 600 : 400,
                }}
              >
                {segment}
              </span>
            </span>
          );
        })}
      </div>

      {/* File list */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '12px',
        }}>
          <h2 style={{ fontSize: '18px', margin: 0, color: '#1e293b' }}>
            {currentPath ? currentPath.split('/').pop() : 'Files'}
          </h2>
          {!manifest.isRevoked && state.payload && (
            <button
              onClick={handleCreateFolder}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '6px 14px', background: '#f1f5f9', border: '1px solid #e2e8f0',
                borderRadius: '8px', cursor: 'pointer', fontSize: '13px', color: '#475569',
                fontWeight: 500, transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#e2e8f0')}
              onMouseLeave={e => (e.currentTarget.style.background = '#f1f5f9')}
            >
              {'\u{1F4C1}'} New Folder
            </button>
          )}
        </div>

        {folders.length === 0 && filesAtPath.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '48px 24px', color: '#94a3b8',
            border: '2px dashed #e2e8f0', borderRadius: '12px',
          }}>
            <p style={{ fontSize: '16px', marginBottom: '8px' }}>
              {currentPath ? 'This folder is empty' : 'No files yet'}
            </p>
            <p style={{ fontSize: '14px' }}>
              {currentPath ? 'Upload files or create a subfolder' : 'Upload files below to get started'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Folders first */}
            {folders.map(folderName => {
              const folderPath = currentPath ? `${currentPath}/${folderName}` : folderName;
              const itemCount = countFolderItems(folderPath);
              return (
                <div key={`folder-${folderName}`} style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '12px 16px', background: '#fffbeb',
                  borderRadius: '10px', border: '1px solid #fde68a',
                  cursor: 'pointer', transition: 'background 0.15s',
                }}
                  onClick={() => setCurrentPath(folderPath)}
                  onMouseEnter={e => (e.currentTarget.style.background = '#fef3c7')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#fffbeb')}
                >
                  <span style={{ fontSize: '24px' }}>{'\u{1F4C2}'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontWeight: 500, color: '#1e293b',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {folderName}
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                      {itemCount} file{itemCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <span style={{ color: '#94a3b8', fontSize: '18px' }}>{'\u203A'}</span>
                </div>
              );
            })}

            {/* Files */}
            {filesAtPath.map(file => (
              <div key={file.id} style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '12px 16px', background: '#f8fafc',
                borderRadius: '10px', border: '1px solid #e2e8f0',
                cursor: 'pointer', transition: 'background 0.15s',
              }}
                onClick={() => handleDownloadFile(file)}
                onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                onMouseLeave={e => (e.currentTarget.style.background = '#f8fafc')}
              >
                <span style={{ fontSize: '24px' }}>{getFileIcon(file.contentType)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontWeight: 500, color: '#1e293b',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {file.fileName}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', fontSize: '12px', color: '#94a3b8' }}>
                    <span>{formatFileSize(file.fileSize)}</span>
                    <span>{'\u00B7'}</span>
                    <span style={{
                      color: file.addedByPublicKey === manifest.ownerPublicKey ? '#3b82f6' : '#22c55e',
                      fontWeight: 600,
                    }}>
                      {file.addedByPublicKey === manifest.ownerPublicKey ? 'Owner' : 'Collaborator'}
                    </span>
                    <span>{'\u00B7'}</span>
                    <span>{formatDate(file.addedAt)}</span>
                  </div>
                </div>
                <div>
                  {state.downloading === file.id ? (
                    <div style={{
                      width: '20px', height: '20px', border: '2px solid #e2e8f0',
                      borderTopColor: '#3b82f6', borderRadius: '50%',
                      animation: 'spin 1s linear infinite',
                    }} />
                  ) : (
                    <span style={{ fontSize: '18px', color: '#94a3b8' }}>{'\u2B07\uFE0F'}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload section */}
      {!manifest.isRevoked && state.payload && (
        <CollabUploader
          groupId={manifest.id}
          payload={state.payload}
          manifest={manifest}
          currentPath={currentPath}
          onUploadComplete={handleUploadComplete}
        />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
