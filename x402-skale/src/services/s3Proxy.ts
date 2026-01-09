/**
 * S3 Pass-Through Proxy Service
 *
 * Proxies requests to the S3 backend, passing through the user's JWT.
 * Does NOT require admin credentials - the S3 backend validates the JWT.
 */

import { config } from '../config/index.js';
import type { S3ProxyRequest, S3ProxyResponse } from '../types/index.js';

/**
 * Proxy a request to the S3 backend
 *
 * @param request - The proxy request parameters
 * @param authHeader - The original Authorization header (JWT)
 * @returns The proxy response
 */
export async function proxyToS3(
  request: S3ProxyRequest,
  authHeader: string
): Promise<S3ProxyResponse> {
  const { method, bucket, key, body, headers = {} } = request;

  // Build the S3 backend URL
  const url = `${config.s3BackendUrl}/${bucket}/${key}`;

  try {
    console.log(`[s3-proxy] ${method} ${url}`);

    // Prepare request headers
    const proxyHeaders: Record<string, string> = {
      ...headers,
      'Authorization': authHeader,
      'Host': new URL(config.s3BackendUrl).host,
    };

    // Make the request
    const response = await fetch(url, {
      method,
      headers: proxyHeaders,
      body: body instanceof Buffer ? body : (body as RequestInit['body']),
      // @ts-ignore - duplex is needed for streaming bodies
      duplex: body ? 'half' : undefined,
    });

    // Extract response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value;
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[s3-proxy] Error ${response.status}: ${errorText}`);

      return {
        success: false,
        status: response.status,
        error: errorText || `S3 error: ${response.status}`,
        headers: responseHeaders,
      };
    }

    // For GET requests, return the body stream
    if (method === 'GET') {
      return {
        success: true,
        status: response.status,
        body: response.body as ReadableStream<Uint8Array>,
        headers: responseHeaders,
      };
    }

    // For PUT requests, try to extract CID from response
    let cid: string | undefined;
    const responseText = await response.text();

    if (responseText) {
      try {
        const responseJson = JSON.parse(responseText);
        cid = responseJson.cid || responseJson.CID || responseJson.Hash;
      } catch {
        // Response might contain CID directly
        // CIDv1 starts with 'baf' (base32), CIDv0 starts with 'Qm' (base58)
        if (responseText.startsWith('Qm') || responseText.startsWith('baf')) {
          cid = responseText.trim();
        }
      }
    }

    // Also check ETag header for CID
    // fula-api returns CIDv1 with raw codec (bafk...) or dag-cbor (bafy...)
    if (!cid && responseHeaders['etag']) {
      const etag = responseHeaders['etag'].replace(/"/g, '');
      if (etag.startsWith('Qm') || etag.startsWith('baf')) {
        cid = etag;
      }
    }

    return {
      success: true,
      status: response.status,
      headers: responseHeaders,
      cid,
    };

  } catch (error) {
    console.error('[s3-proxy] Fetch error:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown proxy error',
    };
  }
}

/**
 * Check if an object exists in S3
 */
export async function headObject(
  bucket: string,
  key: string,
  authHeader: string
): Promise<{
  exists: boolean;
  size?: number;
  contentType?: string;
  etag?: string;
}> {
  const response = await proxyToS3(
    { method: 'HEAD', bucket, key },
    authHeader
  );

  if (!response.success) {
    return { exists: false };
  }

  return {
    exists: true,
    size: response.headers?.['content-length']
      ? parseInt(response.headers['content-length'], 10)
      : undefined,
    contentType: response.headers?.['content-type'],
    etag: response.headers?.['etag']?.replace(/"/g, ''),
  };
}

/**
 * Delete an object from S3
 */
export async function deleteObject(
  bucket: string,
  key: string,
  authHeader: string
): Promise<boolean> {
  const response = await proxyToS3(
    { method: 'DELETE', bucket, key },
    authHeader
  );

  return response.success;
}

/**
 * Build gateway URL for an object (for IPFS access)
 */
export function buildGatewayUrl(cid: string): string {
  // Use public IPFS gateway
  return `https://ipfs.io/ipfs/${cid}`;
}

export default proxyToS3;
