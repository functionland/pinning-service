import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// vi.mock factories are hoisted above top-level consts — everything they
// reference must come from vi.hoisted().
const { mockConfig, db, credits, social, buffer } = vi.hoisted(() => ({
  // Mutable config so individual tests can flip feature flags.
  mockConfig: {
    geminiApiKey: 'g-key',
    geminiImageModel: 'gemini-3.1-flash-image',
    geminiImageSize: '1K',
    socialPostPriceFula: 300,
    maxSocialJobsPerUserPerHour: 10,
    socialPublicBaseUrl: '',
    bufferApiUrl: 'https://api.buffer.com',
    ipfsGatewayUrl: 'https://ipfs.cloud.fx.land/gateway',
    s3GatewayUrl: 'https://s3.cloud.fx.land',
  },
  db: {
    createSocialPost: vi.fn(async () => 'job-1'),
    getSocialPost: vi.fn(async (): Promise<any> => null),
    findSocialPostByIdempotency: vi.fn(async (): Promise<any> => null),
    countRecentSocialJobsByUser: vi.fn(async () => 0),
    failSocialPost: vi.fn(async () => true),
    socialPostExistsByImageCid: vi.fn(async () => true),
  },
  credits: {
    deductCredits: vi.fn(async (): Promise<any> => ({ success: true })),
    refundCredits: vi.fn(async (): Promise<any> => ({ success: true })),
  },
  social: { startSocialJob: vi.fn(() => true) },
  buffer: {
    fetchBufferChannels: vi.fn(async () => [{ id: 'c1', name: 'X acct', service: 'twitter' }]),
    createBufferPosts: vi.fn(async () => [{ channelId: 'c1', ok: true, postId: 'p1' }]),
  },
}));

vi.mock('../src/config/index.js', () => ({ config: mockConfig }));
vi.mock('../src/middleware/jwtValidator.js', () => ({
  jwtValidatorMiddleware: async (c: any, next: any) => {
    c.set('userId', 'user-1');
    c.set('userToken', 'jwt-token');
    await next();
  },
}));
vi.mock('../src/database/social_postgres.js', () => db);
vi.mock('../src/services/creditService.js', () => credits);
vi.mock('../src/services/socialService.js', () => social);
vi.mock('../src/services/bufferService.js', () => buffer);

import { socialRoutes, socialPublicRoutes } from '../src/routes/social.js';

const app = new Hono();
app.route('/api/v1/social', socialPublicRoutes);
app.route('/api/v1/social', socialRoutes);

const VALID_BODY = {
  generationId: 'gen-1',
  websiteUrl: 'https://fxfiles.top/w/k51abc',
  prompt: 'A bakery site',
  assets: [
    { fileName: 'hero.jpg', type: 'image', url: 'https://ipfs.cloud.fx.land/gateway/bafyaaa' },
  ],
  assetPrefix: 'My_Bakery',
};

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

describe('POST /api/v1/social/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.geminiApiKey = 'g-key';
    db.findSocialPostByIdempotency.mockResolvedValue(null);
    db.countRecentSocialJobsByUser.mockResolvedValue(0);
    credits.deductCredits.mockResolvedValue({ success: true });
    social.startSocialJob.mockReturnValue(true);
  });

  it('accepts a valid job: deduct -> insert -> enqueue -> 202', async () => {
    const res = await post('/api/v1/social/generate', VALID_BODY);
    expect(res.status).toBe(202);
    const json = (await res.json()) as any;
    expect(json.jobId).toBeTruthy();
    expect(credits.deductCredits).toHaveBeenCalledWith('user-1', json.jobId, 300);
    expect(db.createSocialPost).toHaveBeenCalled();
    expect(social.startSocialJob).toHaveBeenCalledWith(json.jobId, 'jwt-token');
  });

  it('returns 503 SOCIAL_DISABLED when no Gemini key is configured', async () => {
    mockConfig.geminiApiKey = '';
    const res = await post('/api/v1/social/generate', VALID_BODY);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe('SOCIAL_DISABLED');
    expect(credits.deductCredits).not.toHaveBeenCalled();
  });

  it('returns 402 with required/balance on insufficient credits', async () => {
    credits.deductCredits.mockResolvedValue({
      success: false,
      insufficientBalance: true,
      newBalance: 50,
    });
    const res = await post('/api/v1/social/generate', VALID_BODY);
    expect(res.status).toBe(402);
    const json = (await res.json()) as any;
    expect(json.required).toBe(300);
    expect(json.balance).toBe(50);
  });

  it('returns 429 when the hourly rate limit is hit', async () => {
    db.countRecentSocialJobsByUser.mockResolvedValue(10);
    const res = await post('/api/v1/social/generate', VALID_BODY);
    expect(res.status).toBe(429);
    expect(credits.deductCredits).not.toHaveBeenCalled();
  });

  it.each([
    ['path separator', 'a/b'],
    ['dot-dot', '..'],
    ['single dot', '.'],
    ['space', 'a b'],
  ])('rejects assetPrefix with %s', async (_label, prefix) => {
    const res = await post('/api/v1/social/generate', { ...VALID_BODY, assetPrefix: prefix });
    expect(res.status).toBe(400);
    expect(credits.deductCredits).not.toHaveBeenCalled();
  });

  it('rejects more than 14 assets', async () => {
    const assets = Array.from({ length: 15 }, (_, i) => ({
      fileName: `a${i}.jpg`,
      type: 'image',
      url: 'https://ipfs.cloud.fx.land/gateway/bafyaaa',
    }));
    const res = await post('/api/v1/social/generate', { ...VALID_BODY, assets });
    expect(res.status).toBe(400);
  });

  it('replays an existing Idempotency-Key without deducting again', async () => {
    db.findSocialPostByIdempotency.mockResolvedValue({ id: 'job-existing' });
    const res = await post('/api/v1/social/generate', VALID_BODY, {
      'Idempotency-Key': 'idem-1',
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).jobId).toBe('job-existing');
    expect(credits.deductCredits).not.toHaveBeenCalled();
  });

  it('refunds and replays the winner on a 23505 insert race', async () => {
    db.createSocialPost.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    db.findSocialPostByIdempotency
      .mockResolvedValueOnce(null) // pre-check misses
      .mockResolvedValueOnce({ id: 'job-winner' }); // post-conflict re-select
    const res = await post('/api/v1/social/generate', VALID_BODY, {
      'Idempotency-Key': 'idem-2',
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).jobId).toBe('job-winner');
    expect(credits.refundCredits).toHaveBeenCalledTimes(1);
  });

  it('terminalizes, refunds, and 503s when the queue is saturated', async () => {
    social.startSocialJob.mockReturnValue(false);
    const res = await post('/api/v1/social/generate', VALID_BODY);
    expect(res.status).toBe(503);
    expect(db.failSocialPost).toHaveBeenCalled();
    expect(credits.refundCredits).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/v1/social/status/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.socialPublicBaseUrl = '';
  });

  const ROW = {
    id: 'job-1',
    user_id: 'user-1',
    status: 'completed',
    status_message: 'Social post ready',
    image_cid: VALID_CID,
    image_url: `https://ipfs.cloud.fx.land/gateway/${VALID_CID}`,
    captions: { long: 'L', short: 'S' },
    error_message: null,
    created_at: 't0',
    updated_at: 't1',
  };

  it('404s on a foreign row without leaking existence', async () => {
    db.getSocialPost.mockResolvedValue({ ...ROW, user_id: 'someone-else' });
    const res = await app.request('/api/v1/social/status/job-1');
    expect(res.status).toBe(404);
  });

  it('returns the contract shape with the raw gateway URL by default', async () => {
    db.getSocialPost.mockResolvedValue(ROW);
    const res = await app.request('/api/v1/social/status/job-1');
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.image.url).toBe(ROW.image_url);
    expect(json.captions).toEqual({ long: 'L', short: 'S' });
  });

  it('rewrites the image URL to the passthrough when configured', async () => {
    mockConfig.socialPublicBaseUrl = 'https://ai.cloud.fx.land';
    db.getSocialPost.mockResolvedValue(ROW);
    const res = await app.request('/api/v1/social/status/job-1');
    const json = (await res.json()) as any;
    expect(json.image.url).toBe(`https://ai.cloud.fx.land/api/v1/social/image/${VALID_CID}`);
  });
});

describe('GET /api/v1/social/image/:cid (public passthrough)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    db.socialPostExistsByImageCid.mockResolvedValue(true);
  });

  it('rejects malformed CIDs before any upstream fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await app.request('/api/v1/social/image/not-a-cid');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404s CIDs no social post ever produced (no upstream fetch)', async () => {
    db.socialPostExistsByImageCid.mockResolvedValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await app.request(`/api/v1/social/image/${VALID_CID}`);
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves JPEG bytes with image/jpeg + immutable caching', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest')]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(jpeg), { status: 200 }))
    );
    const res = await app.request(`/api/v1/social/image/${VALID_CID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('refuses non-JPEG payloads (415)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(Buffer.from('<html>nope</html>')), { status: 200 }))
    );
    const res = await app.request(`/api/v1/social/image/${VALID_CID}`);
    expect(res.status).toBe(415);
  });

  it('refuses upstream redirects (502)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })
      )
    );
    const res = await app.request(`/api/v1/social/image/${VALID_CID}`);
    expect(res.status).toBe(502);
  });
});

describe('POST /api/v1/social/buffer/*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.socialPublicBaseUrl = '';
  });

  it('lists channels through the proxy', async () => {
    const res = await post('/api/v1/social/buffer/channels', { bufferToken: 'tok' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channels[0].service).toBe('twitter');
    expect(buffer.fetchBufferChannels).toHaveBeenCalledWith('tok');
  });

  it('rejects posting an image URL we do not host', async () => {
    const res = await post('/api/v1/social/buffer/post', {
      bufferToken: 'tok',
      channelIds: ['c1'],
      text: 'hello',
      imageUrl: 'https://evil.example/steal.jpg',
    });
    expect(res.status).toBe(400);
    expect(buffer.createBufferPosts).not.toHaveBeenCalled();
  });

  it('relays a post for a hosted image URL', async () => {
    const res = await post('/api/v1/social/buffer/post', {
      bufferToken: 'tok',
      channelIds: ['c1'],
      text: 'hello',
      imageUrl: `https://ipfs.cloud.fx.land/gateway/${VALID_CID}`,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).results[0].ok).toBe(true);
  });
});
