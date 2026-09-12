import { describe, expect, it } from 'vitest';

import {
  absolutizeSocialMeta,
  buildAssetFallbackScript,
  injectIntoHead,
  relativeAssetRef,
  relativizeGatewayUrls,
} from '../src/utils/relativeAssets.js';

const CID = 'bafybeicqqub6psgupgkv7vq7gvtvl75qsugbjckmxrdttto4ol5jjxufxy';
const CID2 = 'bafkr4ifv46hreetqo2shfxwohyz24asuum4qxnkubvjm3v3qyojq64xpiu';
const V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

describe('relativizeGatewayUrls — rewrites URL positions', () => {
  it('rewrites every gateway shape, path and subdomain', () => {
    const html = [
      `<img src="https://ipfs.filebase.io/ipfs/${CID}">`,
      `<img src="https://ipfs.cloud.fx.land/gateway/${CID}">`,
      `<img src="https://${CID}.ipfs.dweb.link/">`,
      `<a href="https://ipfs.filebase.io/ipfs/${CID2}">download</a>`,
      `<video poster="https://ipfs.filebase.io/ipfs/${V0}"></video>`,
    ].join('\n');

    const out = relativizeGatewayUrls(html);

    expect(out).not.toMatch(/https:\/\/[^"']*ipfs/);
    expect(out).toContain(`src="../${CID}"`);
    expect(out).toContain(`href="../${CID2}"`);
    expect(out).toContain(`poster="../${V0}"`);
    // three separate img tags all collapse to the same relative form
    expect(out.match(new RegExp(`src="\\.\\./${CID}"`, 'g'))).toHaveLength(3);
  });

  it('rewrites each URL in a srcset, keeping descriptors', () => {
    const html = `<img srcset="https://ipfs.filebase.io/ipfs/${CID} 1x, https://ipfs.filebase.io/ipfs/${CID2} 2x">`;
    expect(relativizeGatewayUrls(html)).toBe(
      `<img srcset="../${CID} 1x, ../${CID2} 2x">`,
    );
  });

  it('rewrites url() inside <style> blocks and style attributes', () => {
    const html =
      `<style>.hero{background-image:url('https://ipfs.filebase.io/ipfs/${CID}')}</style>` +
      `<div style="background:url(https://ipfs.cloud.fx.land/gateway/${CID2})"></div>`;
    const out = relativizeGatewayUrls(html);
    expect(out).toContain(`url('../${CID}')`);
    expect(out).toContain(`url(../${CID2})`);
  });

  it('is idempotent', () => {
    const html = `<img src="https://ipfs.filebase.io/ipfs/${CID}">`;
    const once = relativizeGatewayUrls(html);
    expect(relativizeGatewayUrls(once)).toBe(once);
  });
});

// The attribute-scoping guarantee. A blanket string replace would corrupt page
// content and break social previews; these are the cases that prove it does not.
describe('relativizeGatewayUrls — leaves everything else alone', () => {
  it('does NOT touch a gateway URL in visible text', () => {
    const html = `<p>Find it at https://ipfs.filebase.io/ipfs/${CID} today</p>`;
    expect(relativizeGatewayUrls(html)).toBe(html);
  });

  it('does NOT touch inline JSON', () => {
    const html = `<script type="application/json">{"u":"https://ipfs.filebase.io/ipfs/${CID}"}</script>`;
    expect(relativizeGatewayUrls(html)).toBe(html);
  });

  it('does NOT touch og:image or twitter:image', () => {
    const html =
      `<meta property="og:image" content="https://ipfs.filebase.io/ipfs/${CID}">` +
      `<meta name="twitter:image" content="https://ipfs.filebase.io/ipfs/${CID}">`;
    expect(relativizeGatewayUrls(html)).toBe(html);
  });

  it('does NOT touch ordinary links, or non-gateway URLs that contain a CID-like run', () => {
    const html =
      `<a href="https://example.com/about">About</a>` +
      `<a href="https://www.tiktok.com/@someone">TikTok</a>` +
      `<img src="https://example.com/assets/${CID}">` +
      `<img src="data:image/svg+xml;base64,AAAA">` +
      `<img src="../${CID}">`;
    expect(relativizeGatewayUrls(html)).toBe(html);
  });
});

describe('absolutizeSocialMeta', () => {
  const base = 'https://ipfs.filebase.io/ipfs';

  it('makes a relative og:image absolute so crawlers can fetch it', () => {
    const html = `<meta property="og:image" content="../${CID}">`;
    expect(absolutizeSocialMeta(html, base)).toBe(
      `<meta property="og:image" content="${base}/${CID}">`,
    );
  });

  it('handles content before property, and twitter:image', () => {
    const html = `<meta content="../${CID}" name="twitter:image">`;
    expect(absolutizeSocialMeta(html, base)).toContain(`content="${base}/${CID}"`);
  });

  it('leaves an already-absolute or data: preview alone', () => {
    const abs = `<meta property="og:image" content="https://cdn.example.com/x.png">`;
    const data = `<meta property="og:image" content="data:image/png;base64,AA">`;
    expect(absolutizeSocialMeta(abs, base)).toBe(abs);
    expect(absolutizeSocialMeta(data, base)).toBe(data);
  });

  it('leaves non-image meta tags alone', () => {
    const html = `<meta property="og:title" content="../${CID}">`;
    expect(absolutizeSocialMeta(html, base)).toBe(html);
  });

  it('tolerates a trailing slash on the base', () => {
    const html = `<meta property="og:image" content="../${CID}">`;
    expect(absolutizeSocialMeta(html, `${base}/`)).toContain(`content="${base}/${CID}"`);
  });
});

describe('buildAssetFallbackScript', () => {
  const chain = ['https://ipfs.filebase.io/ipfs', 'https://ipfs.cloud.fx.land/gateway'];

  it('embeds every base, slash-normalised and de-duplicated', () => {
    const s = buildAssetFallbackScript([...chain, chain[0], `${chain[0]}/`]);
    expect(s).toContain('"https://ipfs.filebase.io/ipfs/"');
    expect(s).toContain('"https://ipfs.cloud.fx.land/gateway/"');
    expect(s.match(/ipfs\.filebase\.io/g)).toHaveLength(1);
  });

  // Assigning src from inside an error handler re-triggers error. Without a
  // hard stop the page retries forever and can lock the tab up.
  it('carries an attempt counter and a terminating bound', () => {
    const s = buildAssetFallbackScript(chain);
    expect(s).toContain('data-fx-try');
    expect(s).toContain('tried < CHAIN.length');
  });

  it('registers on the capture phase — img error events do not bubble', () => {
    expect(buildAssetFallbackScript(chain)).toContain(
      "addEventListener('error', function (e) { retry(e.target); }, true)",
    );
  });

  it('sweeps images that already failed before it ran', () => {
    const s = buildAssetFallbackScript(chain);
    expect(s).toContain('DOMContentLoaded');
    expect(s).toContain('naturalWidth === 0');
  });
});

describe('injectIntoHead', () => {
  it('inserts at the START of head, before any img can be parsed', () => {
    const out = injectIntoHead('<html><head><title>t</title></head><body><img src="../x"></body></html>', '<script>S</script>');
    expect(out.indexOf('<script>S</script>')).toBeLessThan(out.indexOf('<title>'));
    expect(out.indexOf('<script>S</script>')).toBeLessThan(out.indexOf('<img'));
  });

  it('falls back to after <html>, then to prepending', () => {
    expect(injectIntoHead('<html><body>x</body></html>', '<b>S</b>')).toContain('<html>\n<b>S</b>');
    expect(injectIntoHead('<p>no head</p>', '<b>S</b>')).toBe('<b>S</b>\n<p>no head</p>');
  });
});

describe('relativeAssetRef', () => {
  it('is the document-relative form', () => {
    expect(relativeAssetRef(CID)).toBe(`../${CID}`);
  });
});
