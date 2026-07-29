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

  it('INLINES generated css/js into every html page (bare-CID gateway serves text/plain+nosniff)', async () => {
    const uploads = mockGateway();
    const files = [
      {
        path: 'index.html',
        content:
          '<link rel="stylesheet" href="./styles.css"><a href="./about.html">About</a><script defer src="./app.js"></script>',
      },
      {
        path: 'about.html',
        content: '<link href="./styles.css"><img src="./hero.png">',
      },
      { path: 'styles.css', content: 'body{color:#111}' },
      { path: 'app.js', content: 'console.log("</scripty ok")' },
      { path: 'hero.png', content: 'PNG' },
    ];

    const result = await publishWebsite(files, 'job1', 'token', {});

    // CSS/JS are NOT uploaded as separate objects — they are inlined.
    expect(uploads.has('website-job1/styles.css')).toBe(false);
    expect(uploads.has('website-job1/app.js')).toBe(false);

    const index = uploads.get('website-job1/index.html')!;
    expect(index).toContain('<style>');
    expect(index).toContain('body{color:#111}');
    expect(index).toContain('<script>');
    expect(index).toContain('console.log');
    expect(index).not.toContain('src="./app.js"');
    expect(index).not.toContain('href="./styles.css"');
    // Subpage link still rewritten to the uploaded subpage's URL.
    expect(index).not.toContain('./about.html');
    expect(index).toContain('https://gw.test/baf');

    // Subpage: stylesheet inlined there too; binary asset rewritten to URL.
    const about = uploads.get('website-job1/about.html')!;
    expect(about).toContain('<style>');
    expect(about).not.toContain('./styles.css');
    expect(about).not.toContain('./hero.png');
    expect(about).toContain('https://gw.test/baf');

    expect(result.cid).toMatch(/^baf/);
    expect(result.gatewayUrl).toContain('https://gw.test/');
  });

  it('single-page sites: css inlined, page self-contained', async () => {
    const uploads = mockGateway();
    const files = [
      { path: 'index.html', content: '<link href="./styles.css">' },
      { path: 'styles.css', content: 'body{}' },
    ];

    const result = await publishWebsite(files, 'job2', 'token', {});
    const index = uploads.get('website-job2/index.html')!;
    expect(index).toContain('<style>');
    expect(index).not.toContain('./styles.css');
    expect(uploads.has('website-job2/styles.css')).toBe(false);
    expect(result.cid).toMatch(/^baf/);
  });

  it('generated svg becomes a data: URI; unreferenced css still uploads as fallback', async () => {
    const uploads = mockGateway();
    const files = [
      { path: 'index.html', content: '<img src="./logo.svg">' },
      { path: 'logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
      { path: 'orphan.css', content: 'body{}' }, // referenced by nothing
    ];

    await publishWebsite(files, 'job4', 'token', {});
    const index = uploads.get('website-job4/index.html')!;
    expect(index).toContain('data:image/svg+xml;base64,');
    expect(index).not.toContain('./logo.svg');
    expect(uploads.has('website-job4/logo.svg')).toBe(false);
    // Not referenced by any html → falls back to upload (harmless orphan).
    expect(uploads.has('website-job4/orphan.css')).toBe(true);
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
