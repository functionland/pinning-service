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
        // Padded to a realistic CIDv1-base32 length. Short stand-ins used to
        // pass here while failing the CID patterns the publish path actually
        // applies — the fixture has to look like the real thing to test it.
        const stem = `baf${key.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
        const cid = stem.padEnd(59, 'q').slice(0, 59);
        return new Response('', { status: 200, headers: { ETag: `"${cid}"` } });
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
    // Subpage link still rewritten to the uploaded subpage — now RELATIVE, so
    // the page resolves it against whichever gateway is serving it.
    expect(index).not.toContain('./about.html');
    expect(index).toContain('"../baf');
    expect(index).not.toContain('https://gw.test/baf');

    // Subpage: stylesheet inlined there too; binary asset rewritten to a
    // relative reference.
    const about = uploads.get('website-job1/about.html')!;
    expect(about).toContain('<style>');
    expect(about).not.toContain('./styles.css');
    expect(about).not.toContain('./hero.png');
    expect(about).toContain('"../baf');
    expect(about).not.toContain('https://gw.test/baf');

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

  it('strips model-authored CSP meta tags and lands deferred head scripts at end of body', async () => {
    const uploads = mockGateway();
    const files = [
      {
        path: 'index.html',
        content:
          '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'">' +
          '<script defer src="./app.js"></script></head>' +
          '<body><h1 class="anim">Hi</h1></body></html>',
      },
      { path: 'app.js', content: 'document.querySelectorAll(".anim")' },
    ];

    await publishWebsite(files, 'job5', 'token', {});
    const index = uploads.get('website-job5/index.html')!;
    // CSP meta gone — it would block the inlined script on every gateway.
    expect(index).not.toContain('Content-Security-Policy');
    // Script no longer in <head>; inlined just before </body> so its DOM
    // queries run against a parsed document (defer semantics preserved).
    expect(index).not.toContain('src="./app.js"');
    const scriptAt = index.indexOf('querySelectorAll');
    const h1At = index.indexOf('<h1');
    const bodyCloseAt = index.indexOf('</body>');
    expect(scriptAt).toBeGreaterThan(h1At);
    expect(scriptAt).toBeLessThan(bodyCloseAt);
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

/**
 * A published site is immutable, so a gateway hostname baked into it is frozen
 * for that site's life — which is how dweb.link's retirement broke the images
 * of every site pointing at it. These run the WHOLE publish transform and
 * assert the shipped bytes name no gateway.
 */
describe('publishWebsite — gateway-agnostic output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const CID = 'bafybeicqqub6psgupgkv7vq7gvtvl75qsugbjckmxrdttto4ol5jjxufxy';

  it('ships no gateway hostname in any asset position', async () => {
    const uploads = mockGateway();
    await publishWebsite(
      [
        {
          path: 'index.html',
          content:
            '<html><head></head><body>' +
            `<img src="https://gw.test/${CID}">` +
            `<img src="https://ipfs.filebase.io/ipfs/${CID}">` +
            '<img src="./hero.png">' +
            '</body></html>',
        },
        { path: 'hero.png', content: 'PNG' },
      ],
      'rel1',
      'token',
      {},
    );

    const index = uploads.get('website-rel1/index.html')!;
    // Model-authored absolutes are relativised too — the deterministic pass is
    // what makes this independent of the model following instructions.
    expect(index).toContain(`src="../${CID}"`);
    expect(index).not.toContain('https://gw.test/baf');
    expect(index).not.toContain('ipfs.filebase.io/ipfs/baf');
    expect(index).toMatch(/src="\.\.\/baf/);
  });

  /**
   * THE ORDERING GUARD. The fallback chain only works because its URLs are
   * ABSOLUTE. If the relativising pass ever runs after the script injection it
   * rewrites the chain inside the script and silently disables the safety net,
   * with no visible symptom until a gateway fails.
   */
  it('keeps the fallback chain ABSOLUTE inside the injected script', async () => {
    const uploads = mockGateway();
    await publishWebsite(
      [{ path: 'index.html', content: '<html><head></head><body><img src="./a.png"></body></html>' },
       { path: 'a.png', content: 'PNG' }],
      'rel2',
      'token',
      {},
    );

    const index = uploads.get('website-rel2/index.html')!;
    expect(index).toContain('https://ipfs.filebase.io/ipfs/');
    expect(index).toContain('https://gw.test/');
    expect(index).toContain('data-fx-try');
    // and the asset itself is still relative
    expect(index).toMatch(/src="\.\.\/baf/);
  });

  it('injects the fallback script into <head>, ahead of any image', async () => {
    const uploads = mockGateway();
    await publishWebsite(
      [{ path: 'index.html', content: '<html><head><title>t</title></head><body><img src="./a.png"></body></html>' },
       { path: 'a.png', content: 'PNG' }],
      'rel3',
      'token',
      {},
    );

    const index = uploads.get('website-rel3/index.html')!;
    // An error listener registered after the images have parsed misses the
    // failures it exists to catch — error events do not replay.
    expect(index.indexOf('data-fx-try')).toBeLessThan(index.indexOf('<img'));
    expect(index.indexOf('data-fx-try')).toBeLessThan(index.indexOf('</head>'));
  });

  it('keeps og:image absolute so crawlers can still fetch a preview', async () => {
    const uploads = mockGateway();
    await publishWebsite(
      [
        {
          path: 'index.html',
          content:
            '<html><head>' +
            '<meta property="og:image" content="./hero.png">' +
            '</head><body><img src="./hero.png"></body></html>',
        },
        { path: 'hero.png', content: 'PNG' },
      ],
      'rel4',
      'token',
      {},
    );

    const index = uploads.get('website-rel4/index.html')!;
    expect(index).toMatch(/property="og:image" content="https:\/\/gw\.test\/baf/);
    // ...while the body image stays relative
    expect(index).toMatch(/<img src="\.\.\/baf/);
  });

  it('subpages get the same treatment as index', async () => {
    const uploads = mockGateway();
    await publishWebsite(
      [
        { path: 'index.html', content: '<html><head></head><body><a href="./about.html">a</a></body></html>' },
        { path: 'about.html', content: '<html><head></head><body><img src="./hero.png"></body></html>' },
        { path: 'hero.png', content: 'PNG' },
      ],
      'rel5',
      'token',
      {},
    );

    const about = uploads.get('website-rel5/about.html')!;
    expect(about).toMatch(/src="\.\.\/baf/);
    expect(about).toContain('data-fx-try');
    expect(about).not.toContain('https://gw.test/baf');

    // A link to another PAGE carries a trailing slash; an ASSET does not.
    // Every page is its own CID, so without the slash the visitor lands at
    // `/ipfs/<cid>` and that page's own `../<asset>` refs resolve one level
    // too high — the site still works, but stops following its gateway.
    const index = uploads.get('website-rel5/index.html')!;
    expect(index).toMatch(/href="\.\.\/baf[a-z0-9]+\/"/);
    expect(about).toMatch(/src="\.\.\/baf[a-z0-9]+"/);
    expect(about).not.toMatch(/src="\.\.\/baf[a-z0-9]+\/"/);
  });
});
