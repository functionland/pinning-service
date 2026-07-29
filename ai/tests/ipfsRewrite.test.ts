import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/index.js', () => ({
  config: {
    s3GatewayUrl: 'http://s3.test',
    s3BucketName: 'ai-websites',
    ipfsGatewayUrl: 'https://gw.test',
    analyticsEndpointUrl: 'https://analytics.test',
  },
}));

import { publishWebsite } from '../src/services/ipfsService.js';

/** Fetch mock: bucket PUT ok; file PUTs return a deterministic per-key CID
 *  ETag and record the uploaded body for assertions. */
function mockGateway() {
  const uploads = new Map<string, string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PUT' && u === 'http://s3.test/ai-websites') {
        return new Response('', { status: 200 });
      }
      if (init?.method === 'PUT') {
        const key = u.replace('http://s3.test/ai-websites/', '');
        const body = init.body as Uint8Array;
        uploads.set(key, new TextDecoder().decode(body));
        return new Response('', {
          status: 200,
          headers: { ETag: `"baf${key.replace(/[^a-z0-9]/gi, '').toLowerCase()}"` },
        });
      }
      if (init?.method === 'DELETE') {
        return new Response('', { status: 204 });
      }
      throw new Error(`unexpected fetch ${init?.method} ${u}`);
    }),
  );
  return uploads;
}

describe('publishWebsite HTML rewriting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('rewrites asset refs in EVERY html page (not just index) and resolves index→subpage links', async () => {
    const uploads = mockGateway();
    const files = [
      {
        path: 'index.html',
        content:
          '<link href="./styles.css"><a href="./about.html">About</a><script src="./app.js"></script>',
      },
      {
        path: 'about.html',
        content: '<link href="./styles.css"><img src="./hero.png">',
      },
      { path: 'styles.css', content: 'body{}' },
      { path: 'app.js', content: 'x()' },
      { path: 'hero.png', content: 'PNG' },
    ];

    const result = await publishWebsite(files, 'job1', 'token', {});

    // Subpage: asset refs rewritten to absolute gateway URLs.
    const aboutKey = 'website-job1/about.html';
    const about = uploads.get(aboutKey)!;
    expect(about).toContain('https://gw.test/baf');
    expect(about).not.toContain('./styles.css');
    expect(about).not.toContain('./hero.png');

    // Index: asset refs AND the subpage link rewritten.
    const index = uploads.get('website-job1/index.html')!;
    expect(index).not.toContain('./styles.css');
    expect(index).not.toContain('./app.js');
    expect(index).not.toContain('./about.html');
    expect(index).toContain('https://gw.test/baf');

    expect(result.cid).toMatch(/^baf/);
    expect(result.gatewayUrl).toContain('https://gw.test/');
  });

  it('single-page sites keep working exactly as before', async () => {
    const uploads = mockGateway();
    const files = [
      { path: 'index.html', content: '<link href="./styles.css">' },
      { path: 'styles.css', content: 'body{}' },
    ];

    const result = await publishWebsite(files, 'job2', 'token', {});
    const index = uploads.get('website-job2/index.html')!;
    expect(index).not.toContain('./styles.css');
    expect(result.cid).toMatch(/^baf/);
  });

  it('still injects the analytics script only into index.html when tracking is on', async () => {
    const uploads = mockGateway();
    const files = [
      { path: 'index.html', content: '<body>hi</body>' },
      { path: 'about.html', content: '<body>about</body>' },
    ];

    await publishWebsite(files, 'job3', 'token', { enableTracking: true });
    expect(uploads.get('website-job3/index.html')).toContain('/api/v1/track');
    expect(uploads.get('website-job3/about.html')).not.toContain('/api/v1/track');
  });
});
