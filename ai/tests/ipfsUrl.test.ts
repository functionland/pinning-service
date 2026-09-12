import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The fetch tests only care about WHICH URLs are requested, so the write is
// stubbed at the top level (vitest hoists vi.mock regardless of placement).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, writeFileSync: vi.fn() },
    writeFileSync: vi.fn(),
  };
});

import { assetFetchCandidates, cidFromGatewayUrl } from '../src/utils/ipfsUrl.js';
import { fetchToFile } from '../src/utils/fetchFile.js';

/**
 * Guards the fix for: website assets never reaching Claude.
 *
 * The client labels each uploaded asset with a PUBLIC gateway URL
 * (`https://<cid>.ipfs.dweb.link/`). The AI service then downloaded the
 * user's own images back through that public gateway and got HTTP 429, so
 * jobs ran with "3 assets (0 attached as blocks)" — the model wrote the
 * page having never seen the pictures, and nothing failed loudly.
 */

const CIDV1 = 'bafybeicqqub6psgupgkv7vq7gvtvl75qsugbjckmxrdttto4ol5jjxufxy';
const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const OWN = 'https://ipfs.cloud.fx.land/gateway';

describe('cidFromGatewayUrl', () => {
  it('reads a CID from the subdomain form the client actually sends', () => {
    expect(cidFromGatewayUrl(`https://${CIDV1}.ipfs.dweb.link/`)).toBe(CIDV1);
    expect(cidFromGatewayUrl(`https://${CIDV1}.ipfs.w3s.link/thing.jpg`)).toBe(CIDV1);
  });

  it('reads a CID from path-style gateway URLs', () => {
    expect(cidFromGatewayUrl(`https://ipfs.io/ipfs/${CIDV1}`)).toBe(CIDV1);
    expect(cidFromGatewayUrl(`https://ipfs.cloud.fx.land/gateway/${CIDV0}`)).toBe(CIDV0);
    expect(cidFromGatewayUrl(`https://ipfs.io/ipfs/${CIDV1}/nested/a.png`)).toBe(CIDV1);
  });

  it('refuses a CIDv0 in the SUBDOMAIN position rather than corrupting it', () => {
    // Hostnames are case-insensitive and `URL.hostname` lowercases them, but
    // CIDv0 is base58btc and case-SENSITIVE — so a lowercased "Qm…" is a
    // DIFFERENT CID, not the same one. (This is exactly why subdomain
    // gateways require the case-insensitive base32 CIDv1.) Returning null
    // makes us fall back to the original URL; returning the lowercased
    // string would have us confidently fetch the wrong content.
    expect(cidFromGatewayUrl(`https://${CIDV0}.ipfs.dweb.link/`)).toBeNull();
    // …but in a PATH the case survives, so it resolves fine there.
    expect(cidFromGatewayUrl(`https://ipfs.io/ipfs/${CIDV0}`)).toBe(CIDV0);
  });

  it('returns null when there is no CID to find', () => {
    expect(cidFromGatewayUrl('https://example.com/photo.jpg')).toBeNull();
    expect(cidFromGatewayUrl('https://example.com/ipfs/not-a-cid')).toBeNull();
    expect(cidFromGatewayUrl('not a url at all')).toBeNull();
    expect(cidFromGatewayUrl('')).toBeNull();
  });

  it('does not mistake an unrelated path segment for a CID', () => {
    // A CID-shaped segment that is NOT behind /ipfs/ or /gateway/ must be
    // ignored — rewriting on that would send us somewhere wrong.
    expect(cidFromGatewayUrl(`https://example.com/uploads/x/${CIDV1}`)).toBeNull();
  });
});

describe('assetFetchCandidates', () => {
  it('puts OUR gateway first and keeps the original as fallback', () => {
    const out = assetFetchCandidates(`https://${CIDV1}.ipfs.dweb.link/`, OWN);
    expect(out).toEqual([
      `${OWN}/${CIDV1}`,
      `https://${CIDV1}.ipfs.dweb.link/`,
    ]);
  });

  it('tolerates a trailing slash on the configured gateway', () => {
    const out = assetFetchCandidates(`https://${CIDV1}.ipfs.dweb.link/`, `${OWN}/`);
    expect(out[0]).toBe(`${OWN}/${CIDV1}`);
  });

  it('leaves a URL alone when it is ALREADY on our gateway', () => {
    const url = `${OWN}/${CIDV1}`;
    expect(assetFetchCandidates(url, OWN)).toEqual([url]);
  });

  it('leaves non-IPFS URLs completely alone', () => {
    const url = 'https://example.com/photo.jpg';
    expect(assetFetchCandidates(url, OWN)).toEqual([url]);
  });

  it('degrades to today’s behaviour when no gateway is configured', () => {
    const url = `https://${CIDV1}.ipfs.dweb.link/`;
    expect(assetFetchCandidates(url, undefined)).toEqual([url]);
    expect(assetFetchCandidates(url, '')).toEqual([url]);
    expect(assetFetchCandidates(url, 'not-a-url')).toEqual([url]);
  });
});

describe('fetchToFile candidate handling', () => {
  const originalFetch = globalThis.fetch;
  let written: string[];

  beforeEach(() => {
    written = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (url: string) => { ok: boolean; status: number }) {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      written.push(url);
      const r = handler(url);
      return {
        ok: r.ok,
        status: r.status,
        arrayBuffer: async () => new ArrayBuffer(4),
      } as any;
    }) as any;
  }

  it('uses the FIRST candidate when it works — the public gateway is never hit', async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    await fetchToFile([`${OWN}/${CIDV1}`, `https://${CIDV1}.ipfs.dweb.link/`], 'out.bin');
    expect(written).toEqual([`${OWN}/${CIDV1}`]);
  });

  it('falls back to the original when our gateway misses', async () => {
    mockFetch((u) => (u.startsWith(OWN) ? { ok: false, status: 404 } : { ok: true, status: 200 }));
    await fetchToFile([`${OWN}/${CIDV1}`, `https://${CIDV1}.ipfs.dweb.link/`], 'out.bin');
    expect(written).toEqual([
      `${OWN}/${CIDV1}`,
      `https://${CIDV1}.ipfs.dweb.link/`,
    ]);
  });

  it('a single URL still gets exactly two attempts (unchanged behaviour)', async () => {
    mockFetch(() => ({ ok: false, status: 429 }));
    await expect(fetchToFile('https://x.example/a.jpg', 'out.bin')).rejects.toThrow(/429/);
    expect(written).toEqual(['https://x.example/a.jpg', 'https://x.example/a.jpg']);
  });

  it('retries the LAST candidate once before giving up', async () => {
    mockFetch(() => ({ ok: false, status: 429 }));
    await expect(
      fetchToFile([`${OWN}/${CIDV1}`, 'https://pub.example/a.jpg'], 'out.bin'),
    ).rejects.toThrow(/429/);
    expect(written).toEqual([
      `${OWN}/${CIDV1}`,
      'https://pub.example/a.jpg',
      'https://pub.example/a.jpg',
    ]);
  });

  it('refuses an empty candidate list rather than fetching nothing', async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    await expect(fetchToFile([], 'out.bin')).rejects.toThrow(/no URL given/);
    expect(written).toEqual([]);
  });
});
