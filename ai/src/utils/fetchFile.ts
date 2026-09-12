/**
 * Shared URL→file fetcher.
 *
 * Extracted from claudeService so other pipelines (social posts) reuse the
 * same bounded download semantics: hard timeout, one retry, byte cap.
 */

import fs from 'fs';

export const FETCH_TIMEOUT_MS = 45_000;
/** Per-file ceiling — defence in depth on the network (the app has already
 *  enforced tighter per-type caps before the URL reaches this service). */
export const MAX_FETCH_BYTES = 32 * 1024 * 1024;

export interface FetchToFileOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Log prefix for the retry warning (e.g. '[claude]', '[social]'). */
  logTag?: string;
  /** 'manual' refuses redirects (callers whose URLs are host-allowlisted
   *  must not let a redirect escape the allowlist). Default 'follow'. */
  redirect?: 'follow' | 'manual';
}

/**
 * Fetch into [destPath], with timeout, one retry, and a byte cap.
 *
 * [url] may be a LIST of equivalent sources tried in order — used to fetch a
 * user's own IPFS content from our gateway before falling back to the public
 * one that rate-limits us (see utils/ipfsUrl.ts). Each candidate gets one
 * attempt and the last gets a retry, so a single-URL call behaves exactly as
 * it always has: two attempts.
 */
export async function fetchToFile(
  url: string | string[],
  destPath: string,
  signal?: AbortSignal,
  opts: FetchToFileOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES;
  const logTag = opts.logTag ?? '[fetch]';

  const candidates = (Array.isArray(url) ? url : [url]).filter(Boolean);
  if (candidates.length === 0) {
    throw new Error('fetch failed: no URL given');
  }
  // One attempt per candidate, plus a retry of the last.
  const attempts = [...candidates, candidates[candidates.length - 1]];

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < attempts.length; attempt++) {
    const target = attempts[attempt];
    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    signal?.addEventListener('abort', onParentAbort);
    const timeoutId = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(target, {
        signal: ac.signal,
        redirect: opts.redirect ?? 'follow',
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`redirect refused (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        throw new Error(`file too large: ${buf.length} bytes (cap ${maxBytes})`);
      }
      fs.writeFileSync(destPath, buf);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (signal?.aborted) {
        throw lastErr;
      }
      if (attempt < attempts.length - 1) {
        const next = attempts[attempt + 1];
        console.warn(
          next === target
            ? `${logTag} fetch retry for ${target}: ${lastErr.message}`
            : `${logTag} fetch failed for ${target} (${lastErr.message}) — falling back to ${next}`,
        );
      }
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }
  throw lastErr ?? new Error('fetch failed');
}
