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

/** The CID the mock gateway returns for an object key. Padded to a realistic
 *  CIDv1-base32 length. Short stand-ins used to pass here while failing the
 *  CID patterns the publish path actually applies — the fixture has to look
 *  like the real thing to test it. */
function cidForKey(key: string): string {
  const stem = `baf${key.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  return stem.padEnd(59, 'q').slice(0, 59);
}

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
        return new Response('', { status: 200, headers: { ETag: `"${cidForKey(key)}"` } });
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
    const imgSrcs = [...index.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]);
    expect(imgSrcs.length).toBe(3);
    for (const src of imgSrcs) expect(src).toMatch(/^\.\.\/baf/);
    expect(index).not.toContain('https://gw.test/baf');

    // The ONE sanctioned absolute gateway URL: the fallback's external copy.
    // It must be absolute to rescue an unslashed page, where a relative ref
    // would resolve one level too high as well.
    const absolute = [...index.matchAll(/\bsrc="(https:\/\/[^"]*)"/g)].map((m) => m[1]);
    expect(absolute).toHaveLength(1);
    expect(absolute[0]).toMatch(/^https:\/\/ipfs\.filebase\.io\/ipfs\/baf/);
    expect(index).toMatch(/<script data-fx defer src="https:\/\/ipfs\.filebase\.io\/ipfs\/baf/);
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
    // On a PUBLIC IPFS gateway, not this service's own (gw.test here): a
    // preview must keep working when fx's servers are down.
    expect(index).toMatch(/property="og:image" content="https:\/\/ipfs\.filebase\.io\/ipfs\/baf/);
    expect(index).not.toMatch(/og:image" content="https:\/\/gw\.test/);
    // ...while the body image stays relative
    expect(index).toMatch(/<img src="\.\.\/baf/);
  });

  /**
   * Filebase (the default gateway) blocks inline scripts, which kills the
   * contact form: its <form> has no action and its inputs no name, so without
   * the submit handler "Send" reloads the page and the message is lost. The
   * page must ship an IPFS-hosted copy of every inline script, plus an
   * absolute external copy of the asset fallback.
   */
  it('ships IPFS-hosted copies of the page scripts and of the fallback', async () => {
    const uploads = mockGateway();
    const CONTACT = "(function(){var f=document.getElementById('cf');f.addEventListener('submit',function(e){e.preventDefault();});})();";
    await publishWebsite(
      [{ path: 'index.html', content: `<html><head></head><body><form id="cf"></form><script>${CONTACT}</script></body></html>` }],
      'fx3',
      'token',
      {},
    );

    // both external files were uploaded as ordinary IPFS content
    const fxFile = (suffix: string) =>
      [...uploads.entries()].filter(([k]) => /^website-fx3\/_fx\/[0-9a-f]{16}-/.test(k) && k.endsWith(suffix));
    expect(fxFile('-asset-fallback.js')).toHaveLength(1);
    expect(fxFile('-inline-0.js')).toHaveLength(1);
    expect(fxFile('-inline-0.js')[0][1]).toContain(CONTACT);
    expect(fxFile('-asset-fallback.js')[0][1]).toContain('__fxAssetFallback');

    const index = uploads.get('website-fx3/index.html')!;
    // original contact script untouched, bracketed by flag + relative copy
    expect(index).toContain(`<script>${CONTACT}</script>`);
    expect(index).toContain('<script data-fx>window.__fxs0=1</script>');
    expect(index).toMatch(/<script data-fx defer src="\.\.\/baf[a-z0-9]+"><\/script>/);
    // the fallback itself is NOT externalised a second time by the generic pass
    expect(fxFile('-inline-1.js')).toHaveLength(0);
    // no dependency on this service's own gateway anywhere in the page
    expect(index).not.toContain('https://gw.test/baf');
  });

  it('republishing a published page does not duplicate the injections', async () => {
    const uploads = mockGateway();
    const page = "<html><head></head><body><script>var x=1;</script></body></html>";
    await publishWebsite([{ path: 'index.html', content: page }], 'rp1', 'token', {});
    const first = uploads.get('website-rp1/index.html')!;

    // Defence in depth: revisions edit the stored SOURCE (generate.ts refuses
    // one without it), so no path feeds published html back in today — but if
    // one ever does, the injections must not stack.
    const uploads2 = mockGateway();
    await publishWebsite([{ path: 'index.html', content: first }], 'rp1', 'token', {});
    const second = uploads2.get('website-rp1/index.html')!;

    for (const html of [first, second]) {
      expect(html.match(/window\.__fxs\d+=1/g)).toHaveLength(1);
      expect(html.match(/data-fx defer src="\.\.\//g)).toHaveLength(1);
      expect(html.match(/__fxAssetFallback = 1/g)).toHaveLength(1);
      expect(html.match(/<script>var x=1;<\/script>/g)).toHaveLength(1);
    }
    expect(second).toBe(first);
    // every opening tag has its own closing tag — no stray markup anywhere
    expect(first.match(/<script\b/g)!.length).toBe(first.match(/<\/script>/g)!.length);
  });

  /**
   * Every page numbers its scripts from 0, so a key built from that number
   * alone is shared by the index and each subpage. The later upload overwrites
   * the earlier one, leaving the earlier page's copy referenced by NO object —
   * nothing keeps it pinned, and on Filebase that page's scripts would stop
   * running once the copy is gone.
   */
  it('pages with different scripts never overwrite each other\'s copies', async () => {
    const uploads = mockGateway();
    const FROM_INDEX = 'var fromIndex=1;';
    const FROM_ABOUT = 'var fromAbout=2;';
    await publishWebsite(
      [
        { path: 'index.html', content: `<html><head></head><body><a href="./about.html">a</a><script>${FROM_INDEX}</script></body></html>` },
        { path: 'about.html', content: `<html><head></head><body><script>${FROM_ABOUT}</script></body></html>` },
        // same script as the index: must share its copy, not write it again
        { path: 'more.html', content: `<html><head></head><body><script>${FROM_INDEX}</script></body></html>` },
      ],
      'two1',
      'token',
      {},
    );

    const puts = (vi.mocked(fetch).mock.calls as [string, RequestInit?][])
      .filter(([u, init]) => init?.method === 'PUT' && String(u).includes('/_fx/'))
      .map(([u]) => String(u));
    // no key written twice: fallback + one copy per DISTINCT script
    expect(new Set(puts).size).toBe(puts.length);
    expect(puts).toHaveLength(3);

    for (const [page, code] of [['index.html', FROM_INDEX], ['about.html', FROM_ABOUT], ['more.html', FROM_INDEX]]) {
      const html = uploads.get(`website-two1/${page}`)!;
      const cid = html.match(/<script data-fx defer src="\.\.\/(baf[a-z0-9]+)"/)![1];
      const owner = [...uploads.entries()].find(([key]) => cidForKey(key) === cid);
      expect(owner?.[1], page).toContain(code);
    }
  });

  /**
   * A failed publish DELETEs what it uploaded, and fula-api drops a pin by CID
   * with no refcount across sites. Byte-identical files would share one CID
   * across every site — the fallback is identical everywhere, a revision's
   * unchanged scripts identical to the live site's — so a single failed
   * publish could unpin a copy that live sites load. Each publish's copies
   * must therefore be its own bytes.
   */
  it('no two sites share the bytes (and so the CID) of an uploaded script', async () => {
    const page = '<html><head></head><body><script>var same=1;</script></body></html>';
    const jsOf = async (jobId: string) => {
      const uploads = mockGateway();
      await publishWebsite([{ path: 'index.html', content: page }], jobId, 'token', {});
      return [...uploads.entries()].filter(([k]) => k.endsWith('.js')).map(([, body]) => body).sort();
    };

    const a = await jsOf('siteA');
    const b = await jsOf('siteB');
    expect(a).toHaveLength(2);
    for (const body of a) expect(b).not.toContain(body);
    // ...while the same publish reproduces its own bytes exactly
    expect(await jsOf('siteA')).toEqual(a);
  });

  // Every uploaded script must actually parse — a file that doesn't is a
  // silent no-op on the one gateway these copies exist for.
  it('every uploaded external script is valid JavaScript', async () => {
    const uploads = mockGateway();
    await publishWebsite(
      [{ path: 'index.html', content: "<html><head></head><body><script>'use strict';var y=2;</script></body></html>" }],
      'js1',
      'token',
      {},
    );
    const jsFiles = [...uploads.entries()].filter(([k]) => k.endsWith('.js'));
    expect(jsFiles.length).toBe(2);
    for (const [key, body] of jsFiles) {
      expect(body, key).not.toMatch(/<\/?script/i);
      expect(() => new Function(body), key).not.toThrow();
    }
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
