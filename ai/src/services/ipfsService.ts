/**
 * IPFS Service
 *
 * Publishes generated website files via the S3 gateway (fula-api) for storage
 * and cluster pinning, then assembles a directory CID using IPFS MFS.
 */

import { config } from '../config/index.js';

export interface PublishResult {
  cid: string;
  gatewayUrl: string;
}

const MAX_RETRIES = 1;
const UPLOAD_CONCURRENCY = 5;
const OVERALL_TIMEOUT_MS = 120_000;

// Content-type map for common website file extensions
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.xml': 'text/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getContentType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// In-memory flag to avoid repeated bucket creation requests
let bucketEnsured = false;

async function ensureBucket(signal: AbortSignal): Promise<void> {
  if (bucketEnsured) return;

  const url = `${config.s3GatewayUrl}/${config.s3BucketName}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${config.s3GatewayJwt}` },
    signal,
  });

  // 200 = created, 409 = already exists — both are fine
  if (!res.ok && res.status !== 409) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to ensure S3 bucket: ${res.status} ${body}`);
  }

  bucketEnsured = true;
  console.log(`[ipfs] S3 bucket "${config.s3BucketName}" ready`);
}

interface UploadedFile {
  path: string;
  cid: string;
  s3Key: string;
}

/**
 * Upload a single file to the S3 gateway with retry.
 */
async function uploadFileToS3(
  file: { path: string; content: string },
  jobId: string,
  signal: AbortSignal
): Promise<UploadedFile> {
  const s3Key = `website-${jobId}/${file.path}`;
  const url = `${config.s3GatewayUrl}/${config.s3BucketName}/${s3Key}`;
  const body = new TextEncoder().encode(file.content);
  const contentType = getContentType(file.path);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[ipfs] Retrying S3 upload for ${file.path} (attempt ${attempt + 1})...`);
    }

    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${config.s3GatewayJwt}`,
          'Content-Type': contentType,
        },
        body,
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`S3 PUT ${s3Key} failed: ${res.status} ${errBody}`);
      }

      // Extract CID from ETag header (strip quotes)
      const etag = res.headers.get('etag') || '';
      const cid = etag.replace(/"/g, '');
      if (!cid) {
        throw new Error(`S3 PUT ${s3Key}: no CID in ETag header`);
      }

      return { path: file.path, cid, s3Key };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isNetworkError =
        lastError.message.includes('ECONNREFUSED') ||
        lastError.message.includes('ECONNRESET') ||
        lastError.message.includes('ETIMEDOUT') ||
        lastError.message.includes('fetch failed');

      if (!isNetworkError || attempt >= MAX_RETRIES) {
        break;
      }
    }
  }

  throw lastError!;
}

/**
 * Run promises with limited concurrency.
 */
async function parallelLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Attempt to clean up uploaded S3 objects on failure.
 */
async function cleanupS3(uploadedKeys: string[]): Promise<void> {
  if (uploadedKeys.length === 0) return;

  try {
    // Delete objects one by one (simple approach, fire-and-forget)
    for (const key of uploadedKeys) {
      const url = `${config.s3GatewayUrl}/${config.s3BucketName}/${key}`;
      await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${config.s3GatewayJwt}` },
      }).catch(() => {});
    }
    console.log(`[ipfs] Cleaned up ${uploadedKeys.length} S3 objects`);
  } catch {
    console.warn('[ipfs] S3 cleanup failed (non-critical)');
  }
}

/**
 * Assemble uploaded files into a directory using IPFS MFS, return root CID.
 */
async function assembleMfsDirectory(
  uploadedFiles: UploadedFile[],
  jobId: string,
  signal: AbortSignal
): Promise<string> {
  const ipfsApi = config.ipfsApiUrl;
  const mfsRoot = `/ai-gen-${jobId}`;

  // 1. Create directory structure
  const mkdirUrl = `${ipfsApi}/api/v0/files/mkdir?arg=${encodeURIComponent(`${mfsRoot}/website`)}&parents=true`;
  const mkdirRes = await fetch(mkdirUrl, { method: 'POST', signal });
  if (!mkdirRes.ok) {
    const body = await mkdirRes.text().catch(() => '');
    throw new Error(`MFS mkdir failed: ${mkdirRes.status} ${body}`);
  }

  // 2. Copy each file CID into the MFS directory
  for (const file of uploadedFiles) {
    const src = `/ipfs/${file.cid}`;
    const dst = `${mfsRoot}/website/${file.path}`;
    // Ensure parent directories exist for nested paths
    const parentDir = dst.slice(0, dst.lastIndexOf('/'));
    if (parentDir !== `${mfsRoot}/website`) {
      const mkParentUrl = `${ipfsApi}/api/v0/files/mkdir?arg=${encodeURIComponent(parentDir)}&parents=true`;
      const mkParentRes = await fetch(mkParentUrl, { method: 'POST', signal });
      if (!mkParentRes.ok) {
        const body = await mkParentRes.text().catch(() => '');
        throw new Error(`MFS mkdir parent failed for ${parentDir}: ${mkParentRes.status} ${body}`);
      }
    }

    const cpUrl = `${ipfsApi}/api/v0/files/cp?arg=${encodeURIComponent(src)}&arg=${encodeURIComponent(dst)}`;
    const cpRes = await fetch(cpUrl, { method: 'POST', signal });
    if (!cpRes.ok) {
      const body = await cpRes.text().catch(() => '');
      throw new Error(`MFS cp failed for ${file.path}: ${cpRes.status} ${body}`);
    }
  }

  // 3. Stat the root to get the directory CID
  const statUrl = `${ipfsApi}/api/v0/files/stat?arg=${encodeURIComponent(mfsRoot)}&hash=true`;
  const statRes = await fetch(statUrl, { method: 'POST', signal });
  if (!statRes.ok) {
    const body = await statRes.text().catch(() => '');
    throw new Error(`MFS stat failed: ${statRes.status} ${body}`);
  }

  const statData = (await statRes.json()) as { Hash: string };
  const directoryCid = statData.Hash;
  if (!directoryCid) {
    throw new Error('MFS stat returned no Hash');
  }

  // 4. Cleanup MFS directory (fire-and-forget)
  const rmUrl = `${ipfsApi}/api/v0/files/rm?arg=${encodeURIComponent(mfsRoot)}&recursive=true`;
  fetch(rmUrl, { method: 'POST' }).catch(() => {});

  return directoryCid;
}

/**
 * Publish website files via S3 gateway + IPFS MFS directory assembly.
 *
 * Phase A: Upload each file to S3 gateway (gets stored in IPFS + cluster pinned)
 * Phase B: Assemble directory structure via MFS (metadata only, no data transfer)
 */
export async function publishWebsite(
  files: Array<{ path: string; content: string }>,
  jobId: string
): Promise<PublishResult> {
  console.log(`[ipfs] Publishing ${files.length} files via S3 gateway + MFS...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS);
  const uploadedKeys: string[] = [];

  try {
    // Ensure bucket exists
    await ensureBucket(controller.signal);

    // Phase A: Upload files to S3 gateway
    console.log(`[ipfs] Phase A: uploading ${files.length} files to S3...`);
    const uploadTasks = files.map((file) => () =>
      uploadFileToS3(file, jobId, controller.signal).then((result) => {
        uploadedKeys.push(result.s3Key);
        return result;
      })
    );

    const uploadedFiles = await parallelLimit(uploadTasks, UPLOAD_CONCURRENCY);
    console.log(`[ipfs] Phase A complete: ${uploadedFiles.length} files uploaded`);

    // Phase B: Assemble directory via MFS
    console.log('[ipfs] Phase B: assembling directory via MFS...');
    const directoryCid = await assembleMfsDirectory(uploadedFiles, jobId, controller.signal);

    // Build gateway URL
    const gatewayBase = config.ipfsGatewayUrl.endsWith('/')
      ? config.ipfsGatewayUrl.slice(0, -1)
      : config.ipfsGatewayUrl;
    const gatewayUrl = `${gatewayBase}/${directoryCid}/website/`;

    console.log(`[ipfs] Published directory CID: ${directoryCid}`);
    console.log(`[ipfs] Gateway URL: ${gatewayUrl}`);

    return { cid: directoryCid, gatewayUrl };
  } catch (error) {
    // Attempt S3 cleanup on failure
    await cleanupS3(uploadedKeys);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
