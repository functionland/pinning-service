import { describe, expect, it } from 'vitest';

import {
  absolutizeSocialMeta,
  buildAssetFallbackExternalTag,
  buildAssetFallbackJs,
  buildAssetFallbackScript,
  externalizeInlineScripts,
  injectIntoHead,
  relativeAssetRef,
  relativizeGatewayUrls,
  stripFxInjections,
} from '../src/utils/relativeAssets.js';

/** Deterministic fake uploader: records each file, returns a CID-shaped id. */
function fakeUpload() {
  const files = new Map<string, string>();
  const upload = async (content: string, name: string) => {
    const cid = `bafy${name.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.padEnd(59, 'q');
    files.set(cid, content);
    return cid;
  };
  return { files, upload };
}

// Filebase (the default gateway) blocks inline scripts with CSP
// `default-src 'self'` — measured 2026-09-16. These pin the external copies
// that let the fallback and a page's own code run there anyway.
describe('fallback runs where inline scripts are blocked (fix 2)', () => {
  const chain = ['https://ipfs.filebase.io/ipfs', 'https://ipfs.cloud.fx.land/gateway'];

  it('the fallback code guards itself — some gateways run BOTH copies', () => {
    // Measured: on inbrowser.link the inline copy AND the external copy ran.
    const js = buildAssetFallbackJs(chain);
    expect(js).toContain('if (window.__fxAssetFallback) return;');
    expect(js.indexOf('__fxAssetFallback = 1')).toBeLessThan(js.indexOf('addEventListener'));
  });

  it('inline and external copies carry the same code', () => {
    expect(buildAssetFallbackScript(chain)).toContain(buildAssetFallbackJs(chain));
  });

  // Regression: splitting the code out of the <script> wrapper once left the
  // wrapper's closing `</script>` inside the CODE. The uploaded external file
  // was then a syntax error — silently breaking the fallback on exactly the
  // gateway it exists for — and the inline copy leaked stray text into <head>.
  it('the external file is valid JavaScript with no markup in it', () => {
    const js = buildAssetFallbackJs(chain);
    expect(js).not.toMatch(/<\/?script/i);
    expect(() => new Function(js)).not.toThrow();
  });

  it('the inline copy has exactly one opening and one closing tag', () => {
    const tag = buildAssetFallbackScript(chain);
    expect(tag.match(/<script\b/g)).toHaveLength(1);
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
    expect(tag.trimEnd().endsWith('</script>')).toBe(true);
  });

  it('the external copy is an absolute, deferred, marked script tag', () => {
    const tag = buildAssetFallbackExternalTag('https://ipfs.filebase.io/ipfs/bafyx');
    expect(tag).toBe('<script data-fx defer src="https://ipfs.filebase.io/ipfs/bafyx"></script>');
  });
});

describe('externalizeInlineScripts (fix 3)', () => {
  const CONTACT = `(function(){var f=document.getElementById('cf');f.addEventListener('submit',function(e){e.preventDefault();});})();`;

  it('keeps the original byte-identical and brackets it with flag + external copy', async () => {
    const { files, upload } = fakeUpload();
    const html = `<form id="cf"></form><script>${CONTACT}</script>`;
    const out = await externalizeInlineScripts(html, upload);

    expect(out).toContain(`<script>${CONTACT}</script>`);
    const flagAt = out.indexOf('<script data-fx>window.__fxs0=1</script>');
    const origAt = out.indexOf(`<script>${CONTACT}</script>`);
    const extAt = out.search(/<script data-fx defer src="\.\.\/bafy/);
    expect(flagAt).toBeGreaterThanOrEqual(0);
    expect(flagAt).toBeLessThan(origAt);
    expect(origAt).toBeLessThan(extAt);

    // external file = guard + original
    expect(files.size).toBe(1);
    const ext = [...files.values()][0];
    expect(ext.startsWith("if (window.__fxs0) throw 'fx: this script already ran inline';\n")).toBe(true);
    expect(ext.endsWith(CONTACT)).toBe(true);
  });

  // Where inline runs, every copy aborts with a throw — which would reach the
  // site's own error handlers and the console on every view. One listener,
  // ahead of all site scripts, cancels exactly that error.
  it('silences the guard\'s own abort, once per page, ahead of every site script', async () => {
    const { files, upload } = fakeUpload();
    const out = await externalizeInlineScripts('<script>var a=1;</script><p>x</p><script>var b=2;</script>', upload);

    const silencers = out.match(/<script data-fx>window\.addEventListener\('error'/g);
    expect(silencers).toHaveLength(1);
    expect(out.indexOf("window.addEventListener('error'")).toBeLessThan(out.indexOf('<script>var a=1;'));

    // it cancels the very value the copies throw — they cannot drift apart
    const thrown = [...files.values()][0].match(/throw ('[^']*')/)![1];
    expect(out).toContain(`e.error === ${thrown}`);
    expect(out).toMatch(/e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\)/);
  });

  it('adds no silencer to a page with nothing to externalise', async () => {
    const { upload } = fakeUpload();
    const html = '<script type="application/ld+json">{}</script>';
    expect(await externalizeInlineScripts(html, upload)).toBe(html);
  });

  it('references the external copy RELATIVELY — no gateway host in the page', async () => {
    const { upload } = fakeUpload();
    const out = await externalizeInlineScripts('<script>var a=1;</script>', upload);
    expect(out).not.toMatch(/src="https?:/);
    expect(out).toMatch(/src="\.\.\/bafy/);
  });

  it("puts the guard AFTER a 'use strict' directive so strictness survives", async () => {
    const { files, upload } = fakeUpload();
    await externalizeInlineScripts(`<script>\n'use strict';\nvar a=1;</script>`, upload);
    const ext = [...files.values()][0];
    expect(ext).toMatch(/^\s*'use strict';\s*if \(window\.__fxs0\) throw/);
  });

  it('leaves external, marked, non-JS and empty scripts alone', async () => {
    const { files, upload } = fakeUpload();
    const html =
      '<script src="../bafyexisting"></script>' +
      '<script data-fx>window.__fxs9=1</script>' +
      '<script type="application/ld+json">{"@type":"Org"}</script>' +
      '<script type="module">import x from "./x.js";</script>' +
      '<script type="text/template"><b>t</b></script>' +
      '<script>   </script>';
    const out = await externalizeInlineScripts(html, upload);
    expect(out).toBe(html);
    expect(files.size).toBe(0);
  });

  // A modern browser never runs a nomodule script, but an external copy
  // carries no nomodule — on Filebase the legacy code would suddenly run.
  it('leaves nomodule scripts alone', async () => {
    const { files, upload } = fakeUpload();
    const html = '<script nomodule>window.legacy=1;</script>';
    expect(await externalizeInlineScripts(html, upload)).toBe(html);
    expect(files.size).toBe(0);
  });

  // Attribute names are matched whole: data-src is not src, data-type is not
  // type, and neither may cost a script its copy.
  it('does not mistake data-* attributes for src or type', async () => {
    const { files, upload } = fakeUpload();
    await externalizeInlineScripts(
      '<script data-src="x">var a=1;</script><script data-type="widget">var b=2;</script>',
      upload,
    );
    expect(files.size).toBe(2);
  });

  it('externalises explicit classic types', async () => {
    const { files, upload } = fakeUpload();
    await externalizeInlineScripts(
      '<script type="text/javascript">var a=1;</script><script type="application/javascript">var b=2;</script>',
      upload,
    );
    expect(files.size).toBe(2);
  });

  it('two identical scripts stay two scripts, with distinct flags', async () => {
    const { upload } = fakeUpload();
    const out = await externalizeInlineScripts('<script>var a=1;</script><script>var a=1;</script>', upload);
    expect(out).toContain('window.__fxs0=1');
    expect(out).toContain('window.__fxs1=1');
    expect(out.match(/<script>var a=1;<\/script>/g)).toHaveLength(2);
  });

  it('is idempotent once previous injections are stripped', async () => {
    const { upload } = fakeUpload();
    const html = `<form id="cf"></form><script>${CONTACT}</script>`;
    const once = await externalizeInlineScripts(html, upload);
    const twice = await externalizeInlineScripts(stripFxInjections(once), upload);
    expect(twice).toBe(once);
    expect(twice.match(/data-fx defer/g)).toHaveLength(1);
  });
});

describe('stripFxInjections', () => {
  it('removes exactly the data-fx tags, preserving surrounding bytes', () => {
    const html =
      '<head><script data-fx>\n(function(){})()\n</script>' +
      '<script data-fx defer src="https://ipfs.filebase.io/ipfs/bafyx"></script>' +
      '\n<script>var keep=1;</script>\n</head>';
    expect(stripFxInjections(html)).toBe('<head>\n<script>var keep=1;</script>\n</head>');
  });

  // Pages published by the first release carry an UNMARKED, UNGUARDED
  // fallback. Left in place on a republish it would register alongside the new
  // one and double every retry.
  it('also removes the legacy unmarked fallback', () => {
    const legacy = `<html><head>\n<script>\n(function () {\n  var CHAIN = ["https://ipfs.filebase.io/ipfs/"];\n  var CID = /x/;\n})();\n</script><title>t</title></head></html>`;
    expect(stripFxInjections(legacy)).toBe('<html><head><title>t</title></head></html>');
  });

  // Only the exact `data-fx` marker: a site's own data-fx-* attribute is not
  // ours, and stripping it would delete the site's script.
  it('never strips a site script whose attribute merely starts with data-fx', () => {
    const html = '<script data-fx-widget="1">var keep=1;</script><script class="data-fx">var keep=2;</script>';
    expect(stripFxInjections(html)).toBe(html);
  });

  it('never touches a site script that merely mentions CHAIN', () => {
    const html = '<script>var CHAIN = [1,2];</script>';
    expect(stripFxInjections(html)).toBe(html);
  });
});

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
    expect(injectIntoHead('<html><body>x</body></html>', '<b>S</b>')).toContain('<html><b>S</b>');
    expect(injectIntoHead('<p>no head</p>', '<b>S</b>')).toBe('<b>S</b><p>no head</p>');
  });

  // stripFxInjections removes exactly the injected tags; any whitespace added
  // here would survive a strip and make republishing non-idempotent.
  it('adds no whitespace around the snippet', () => {
    expect(injectIntoHead('<head></head>', '<script data-fx></script>')).toBe(
      '<head><script data-fx></script></head>',
    );
  });
});

describe('relativeAssetRef', () => {
  it('is the document-relative form', () => {
    expect(relativeAssetRef(CID)).toBe(`../${CID}`);
  });
});
