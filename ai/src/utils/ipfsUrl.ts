/**
 * Fetch a user's own IPFS content from OUR gateway, not a public one.
 *
 * The FxFiles client labels every uploaded asset with a PUBLIC gateway URL
 * (`https://<cid>.ipfs.dweb.link/`) because that is the link a visitor's
 * browser will use. When this service then downloads those assets to show
 * Claude, it was fetching the user's own images back through that same
 * public gateway — which rate-limits us:
 *
 *   [claude] asset IMG-….jpg not attached: download failed: HTTP 429
 *   [claude] Generating: 3 assets (0 attached as blocks)
 *
 * The generation still "succeeds", but the model never SEES the pictures —
 * it gets URLs and writes the page blind. That is a silent quality
 * regression on exactly the sites that are most about their images.
 *
 * The content is already on our own IPFS gateway (we pinned it), so we
 * resolve the CID out of the public URL and try our gateway FIRST, keeping
 * the original as a fallback so a misconfigured gateway can never make
 * asset fetching worse than it is today.
 */

import { CID_PATTERN } from './cid.js';

/**
 * Pull the CID out of a gateway URL, in either shape:
 *   subdomain — `https://<cid>.ipfs.dweb.link/…`
 *   path      — `https://host/ipfs/<cid>/…`, `https://host/gateway/<cid>`
 * Returns null when the URL carries no recognisable CID.
 */
export function cidFromGatewayUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Subdomain style: the label immediately before `.ipfs.` is the CID.
  const host = parsed.hostname;
  const ipfsIdx = host.indexOf('.ipfs.');
  if (ipfsIdx > 0) {
    const label = host.slice(0, ipfsIdx);
    if (CID_PATTERN.test(label)) return label;
  }

  // Path style: the first path segment that looks like a CID, but only
  // directly after a gateway-ish segment so we never pick a CID out of an
  // unrelated path.
  const segments = parsed.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!CID_PATTERN.test(seg)) continue;
    const prev = i > 0 ? segments[i - 1] : '';
    if (i === 0 || prev === 'ipfs' || prev === 'gateway') return seg;
  }

  return null;
}

/** Hostname of a base URL, or '' when it is unusable. */
function hostOf(base: string): string {
  try {
    return new URL(base).hostname;
  } catch {
    return '';
  }
}

/**
 * Ordered download candidates for an asset URL.
 *
 * Returns our own gateway first, then the original, so a failure of the
 * rewrite degrades to exactly today's behaviour rather than dropping the
 * asset. Returns a single-element list when there is nothing to gain:
 * no CID in the URL, no configured gateway, or the URL is already ours.
 */
export function assetFetchCandidates(
  url: string,
  ownGatewayBase: string | undefined | null,
): string[] {
  if (!ownGatewayBase) return [url];

  const base = ownGatewayBase.endsWith('/')
    ? ownGatewayBase.slice(0, -1)
    : ownGatewayBase;
  const ownHost = hostOf(base);
  if (!ownHost) return [url];

  // Already pointed at our own gateway — nothing to rewrite.
  const urlHost = hostOf(url);
  if (urlHost && urlHost === ownHost) return [url];

  const cid = cidFromGatewayUrl(url);
  if (!cid) return [url];

  const local = `${base}/${cid}`;
  return local === url ? [url] : [local, url];
}
