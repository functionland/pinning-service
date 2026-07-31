import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above top-level consts — everything they
// reference must come from vi.hoisted().
const { db, credits } = vi.hoisted(() => ({
  db: {
    getSocialPost: vi.fn(),
    updateSocialPostStatus: vi.fn(),
    completeSocialPost: vi.fn(),
    failSocialPost: vi.fn(),
    reapStaleSocialPosts: vi.fn(async (): Promise<any[]> => []),
  },
  credits: {
    refundCredits: vi.fn(async (): Promise<any> => ({ success: true })),
  },
}));

vi.mock('../src/config/index.js', () => ({
  config: {
    geminiApiKey: 'g',
    geminiImageModel: 'm',
    geminiImageSize: '1K',
    claudeApiKey: 'c',
    claudeModel: 'claude-opus-5',
    claudeSocialModel: '',
    maxConcurrentSocialJobs: 2,
    socialJobTimeoutMs: 300000,
    socialMaxReferenceImages: 8,
    socialRefAllowedHosts: '.dweb.link,.w3s.link,.ipfs.io',
    socialAssetsBucket: 'website-assets',
    ipfsGatewayUrl: 'https://ipfs.cloud.fx.land/gateway',
    s3GatewayUrl: 'https://s3.cloud.fx.land',
  },
}));
vi.mock('../src/database/social_postgres.js', () => db);
vi.mock('../src/services/creditService.js', () => credits);

import {
  reapStaleSocialJobsOnBoot,
  isAllowedRefUrl,
  refFetchUrl,
} from '../src/services/socialService.js';

describe('reapStaleSocialJobsOnBoot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when no stale rows exist', async () => {
    db.reapStaleSocialPosts.mockResolvedValue([]);
    await reapStaleSocialJobsOnBoot();
    expect(credits.refundCredits).not.toHaveBeenCalled();
  });

  it('refunds exactly the charged rows the flip RETURNed', async () => {
    db.reapStaleSocialPosts.mockResolvedValue([
      { id: 'j1', user_id: 'u1', credits_charged: 300 },
      { id: 'j2', user_id: 'u2', credits_charged: 0 },
      { id: 'j3', user_id: 'u3', credits_charged: 300 },
    ]);
    await reapStaleSocialJobsOnBoot();
    expect(credits.refundCredits).toHaveBeenCalledTimes(2);
    expect(credits.refundCredits).toHaveBeenCalledWith('u1', 'j1', 300);
    expect(credits.refundCredits).toHaveBeenCalledWith('u3', 'j3', 300);
  });

  it('survives a refund failure and keeps refunding the rest', async () => {
    db.reapStaleSocialPosts.mockResolvedValue([
      { id: 'j1', user_id: 'u1', credits_charged: 300 },
      { id: 'j2', user_id: 'u2', credits_charged: 300 },
    ]);
    credits.refundCredits
      .mockRejectedValueOnce(new Error('credit svc down'))
      .mockResolvedValueOnce({ success: true });
    await reapStaleSocialJobsOnBoot();
    expect(credits.refundCredits).toHaveBeenCalledTimes(2);
  });
});

const VALID_CID =
  'bafkr4ihc6u2d55kyv6wyy6v2ehdttid7ewjm52tcbtjb7xehinbnj55hxe';

describe('isAllowedRefUrl', () => {
  it('accepts https URLs on our gateway hosts', () => {
    expect(isAllowedRefUrl('https://ipfs.cloud.fx.land/gateway/bafyabc')).toBe(true);
    expect(isAllowedRefUrl('https://s3.cloud.fx.land/website-assets/g/x.jpg')).toBe(true);
  });
  it('accepts subdomain gateways via the configured suffix rules', () => {
    // The FxFiles client's DEFAULT gateway shape — rejecting it is what
    // silently dropped every reference image in the first live run.
    expect(isAllowedRefUrl(`https://${VALID_CID}.ipfs.dweb.link/`)).toBe(true);
    expect(isAllowedRefUrl(`https://${VALID_CID}.ipfs.w3s.link/`)).toBe(true);
  });
  it('rejects other hosts, http, and garbage', () => {
    expect(isAllowedRefUrl('https://evil.example/x.jpg')).toBe(false);
    expect(isAllowedRefUrl('http://ipfs.cloud.fx.land/gateway/bafyabc')).toBe(false);
    // Suffix rules must not match a lookalike host.
    expect(isAllowedRefUrl('https://notdweb.link.evil.example/x')).toBe(false);
    expect(isAllowedRefUrl('not a url')).toBe(false);
    expect(isAllowedRefUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('refFetchUrl', () => {
  it('resolves a CID against OUR gateway, ignoring the client URL', () => {
    expect(
      refFetchUrl({
        fileName: 'a.jpg',
        type: 'image',
        url: `https://${VALID_CID}.ipfs.dweb.link/`,
        cid: VALID_CID,
      })
    ).toBe(`https://ipfs.cloud.fx.land/gateway/${VALID_CID}`);
  });

  it('works for a cid-only asset with no url at all', () => {
    expect(
      refFetchUrl({ fileName: 'a.jpg', type: 'image', url: '', cid: VALID_CID })
    ).toBe(`https://ipfs.cloud.fx.land/gateway/${VALID_CID}`);
  });

  it('falls back to an allow-listed url when the cid is absent or bogus', () => {
    const url = `https://${VALID_CID}.ipfs.dweb.link/`;
    expect(refFetchUrl({ fileName: 'a.jpg', type: 'image', url })).toBe(url);
    expect(
      refFetchUrl({ fileName: 'a.jpg', type: 'image', url, cid: 'not-a-cid' })
    ).toBe(url);
  });

  it('returns null when neither a cid nor an allowed url is usable', () => {
    expect(
      refFetchUrl({
        fileName: 'a.jpg',
        type: 'image',
        url: 'https://evil.example/x.jpg',
      })
    ).toBeNull();
  });
});
