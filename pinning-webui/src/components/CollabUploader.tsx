import { useState, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  deriveCollabFileKey,
  encryptCollabFile,
  uploadCollabFile,
  updateCollabManifest,
  type CollaborationPayload,
  type CollaborationManifest,
  type CollaborationFile,
} from '../services/sharingService';

interface CollabUploaderProps {
  groupId: string;
  payload: CollaborationPayload;
  manifest: CollaborationManifest;
  currentPath: string;
  onUploadComplete: () => void;
}

interface UploadProgress {
  fileName: string;
  progress: number; // 0-100
  status: 'encrypting' | 'uploading' | 'done' | 'error';
  error?: string;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export default function CollabUploader({
  groupId,
  payload,
  manifest,
  currentPath,
  onUploadComplete,
}: CollabUploaderProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList) => {
    if (isUploading) return;

    const fileArray = Array.from(files);
    const validFiles = fileArray.filter(f => {
      if (f.size > MAX_FILE_SIZE) {
        alert(`File "${f.name}" is too large (max 100MB)`);
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) return;

    setIsUploading(true);
    const progress: UploadProgress[] = validFiles.map(f => ({
      fileName: f.name,
      progress: 0,
      status: 'encrypting',
    }));
    setUploads(progress);

    const linkSecret = Uint8Array.from(atob(payload.sk), c => c.charCodeAt(0));
    const newFiles: CollaborationFile[] = [];

    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      const fileId = uuidv4();

      try {
        // Step 1: Encrypt
        setUploads(prev => prev.map((p, idx) =>
          idx === i ? { ...p, status: 'encrypting', progress: 20 } : p
        ));

        const arrayBuffer = await file.arrayBuffer();
        const key = await deriveCollabFileKey(linkSecret, fileId);
        const encrypted = await encryptCollabFile(arrayBuffer, key);

        // Step 2: Upload
        setUploads(prev => prev.map((p, idx) =>
          idx === i ? { ...p, status: 'uploading', progress: 60 } : p
        ));

        const result = await uploadCollabFile(
          groupId,
          fileId,
          file.name,
          file.type || 'application/octet-stream',
          encrypted
        );

        // Build file entry
        newFiles.push({
          id: fileId,
          fileName: file.name,
          contentType: file.type || undefined,
          bucket: result.bucket,
          storageKey: result.storageKey,
          pathScope: currentPath || undefined,
          addedByPublicKey: 'web-collaborator',
          addedAt: new Date().toISOString(),
          fileSize: file.size,
          encType: 'collab',
        });

        setUploads(prev => prev.map((p, idx) =>
          idx === i ? { ...p, status: 'done', progress: 100 } : p
        ));
      } catch (err) {
        console.error(`[CollabUploader] Failed to upload ${file.name}:`, err);
        setUploads(prev => prev.map((p, idx) =>
          idx === i ? {
            ...p,
            status: 'error',
            progress: 0,
            error: err instanceof Error ? err.message : 'Upload failed',
          } : p
        ));
      }
    }

    // Step 3: Update manifest with new files
    if (newFiles.length > 0) {
      try {
        const updatedManifest: CollaborationManifest = {
          ...manifest,
          files: [...manifest.files, ...newFiles],
          version: manifest.version + 1,
          updatedAt: new Date().toISOString(),
        };
        await updateCollabManifest(groupId, updatedManifest, linkSecret);
        onUploadComplete();
      } catch (err) {
        console.error('[CollabUploader] Failed to update manifest:', err);
        alert('Files uploaded but failed to update the group manifest. Please try again.');
      }
    }

    setIsUploading(false);

    // Clear progress after delay
    setTimeout(() => setUploads([]), 3000);
  }, [groupId, payload, manifest, currentPath, onUploadComplete, isUploading]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = ''; // Reset so same file can be selected again
    }
  }, [handleFiles]);

  return (
    <div>
      <h2 style={{ fontSize: '18px', marginBottom: '12px', color: '#1e293b' }}>
        Upload Files
      </h2>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${isDragOver ? '#3b82f6' : '#cbd5e1'}`,
          borderRadius: '12px',
          padding: '32px',
          textAlign: 'center',
          cursor: isUploading ? 'default' : 'pointer',
          background: isDragOver ? 'rgba(59, 130, 246, 0.05)' : 'transparent',
          transition: 'all 0.2s',
          opacity: isUploading ? 0.6 : 1,
          pointerEvents: isUploading ? 'none' : 'auto',
        }}
      >
        <div style={{ fontSize: '36px', marginBottom: '8px' }}>{'\u{1F4E4}'}</div>
        <p style={{ color: '#64748b', margin: '0 0 4px 0', fontWeight: 500 }}>
          {isDragOver ? 'Drop files here' : 'Drop files here or click to upload'}
        </p>
        <p style={{ color: '#94a3b8', margin: 0, fontSize: '13px' }}>
          Max 100MB per file. Files are encrypted before upload.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileInput}
        style={{ display: 'none' }}
      />

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {uploads.map((up, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '10px 14px', background: '#f8fafc',
              borderRadius: '8px', border: '1px solid #e2e8f0',
            }}>
              <span style={{ fontSize: '18px' }}>
                {up.status === 'done' ? '\u2705' : up.status === 'error' ? '\u274C' : '\u{1F4C4}'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '13px', fontWeight: 500, color: '#1e293b',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {up.fileName}
                </div>
                {up.error && (
                  <div style={{ fontSize: '12px', color: '#ef4444' }}>{up.error}</div>
                )}
                {up.status !== 'done' && up.status !== 'error' && (
                  <div style={{
                    marginTop: '4px', height: '4px', background: '#e2e8f0',
                    borderRadius: '2px', overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%', background: '#3b82f6',
                      width: `${up.progress}%`, transition: 'width 0.3s',
                      borderRadius: '2px',
                    }} />
                  </div>
                )}
              </div>
              <span style={{ fontSize: '12px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                {up.status === 'encrypting' ? 'Encrypting...' :
                 up.status === 'uploading' ? 'Uploading...' :
                 up.status === 'done' ? 'Done' : 'Failed'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
