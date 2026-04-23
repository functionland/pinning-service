/**
 * Gateway disclaimer wrapper
 *
 * Returns a self-contained HTML page shown by the gateway before rendering
 * inline-viewable third-party content (HTML, images, videos, audio, PDFs,
 * SVG). A modal overlays a blurred <iframe> of the real content fetched via
 * `/gateway/<cid>?agreed=1`. User interaction with the iframe is disabled
 * (pointer-events: none) until the user clicks "I Agree" or the CID is
 * already remembered in localStorage.
 *
 * All CSS/JS is inline so the page has no external dependencies and can run
 * under a strict CSP.
 */

const HTML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => HTML_ESCAPES[c]);
}

/**
 * Build the iframe query string: strip wrapper-control params and append
 * agreed=1 so the iframe request bypasses this wrapper.
 */
function buildIframeQuery(passthroughQuery) {
  const drop = new Set(['view', 'agreed', 'raw', 'download']);
  const pairs = [];
  for (const [k, v] of Object.entries(passthroughQuery || {})) {
    if (drop.has(k)) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const vv of vals) {
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(vv))}`);
    }
  }
  pairs.push('agreed=1');
  return '?' + pairs.join('&');
}

function renderWrapper(cidDisplay, passthroughQuery) {
  const safeCidHtml = escapeHtml(cidDisplay);
  // JSON.stringify does NOT escape <, >, & — embedded inside a <script> tag,
  // an input containing "</script>" would break out of the tag. Escape those
  // to their \uXXXX forms so the payload is safe inside script content.
  // (CIDs themselves never contain U+2028/U+2029; ES2019+ parses those in
  // string literals anyway, so no separate escape is needed.)
  const cidJson = JSON.stringify(String(cidDisplay))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const iframeSrc = escapeHtml(
    `/gateway/${encodeURIComponent(cidDisplay)}${buildIframeQuery(passthroughQuery)}`
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; connect-src 'self';">
<title>Content warning - Functionland gateway</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #111827; }
  .wrap { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
  .content { width: 100%; height: 100%; border: 0; display: block; filter: blur(20px); transition: filter .25s ease; pointer-events: none; background: #111827; }
  .wrap.ok .content { filter: none; pointer-events: auto; }
  .overlay { position: fixed; inset: 0; background: rgba(15,23,42,.55); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 2147483647; }
  .overlay.hidden { display: none; }
  .modal { background: #fff; color: #111827; border-radius: 12px; box-shadow: 0 24px 48px rgba(0,0,0,.35); max-width: 560px; width: 100%; padding: 28px 28px 22px; }
  .modal h1 { margin: 0 0 12px; font-size: 20px; }
  .modal p { margin: 0 0 12px; font-size: 14px; line-height: 1.55; color: #374151; }
  .modal code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12px; word-break: break-all; }
  .btns { display: flex; gap: 10px; margin-top: 18px; }
  .btn { flex: 1; padding: 10px 14px; border: 0; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; transition: background .15s; }
  .btn-primary { background: #2563eb; color: #fff; } .btn-primary:hover { background: #1d4ed8; }
  .btn-secondary { background: #e5e7eb; color: #111827; } .btn-secondary:hover { background: #d1d5db; }
  .remember { display: block; width: 100%; margin-top: 14px; background: transparent; border: 0; color: #6b7280; font-size: 12px; text-decoration: underline; cursor: pointer; }
  .remember:hover { color: #374151; }
  .blocked h1 { color: #991b1b; }
  .blocked p { color: #4b5563; }
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <!-- Sandbox omits allow-same-origin on purpose: without it the iframe runs
       with an opaque origin and cannot reach parent.localStorage, so a
       malicious CID can't silently add itself to the consent list. Trade-off:
       IPFS apps that rely on gateway-wide localStorage/cookies won't persist
       state between visits — an acceptable cost for public third-party
       content. -->
  <iframe class="content" id="content" src="${iframeSrc}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-popups"></iframe>
  <div class="overlay" id="overlay">
    <div class="modal" id="modal">
      <div id="disclaimer">
        <h1>This content is not affiliated with Functionland</h1>
        <p>You are about to view content fetched from the IPFS network. Functionland and the Fula Network are <strong>not the author, host, or endorser</strong> of this content &mdash; we only act as a gateway to decentralized content published by unknown third parties.</p>
        <p><strong>Do not enter passwords, share private information, or interact with forms</strong> on this page unless you are certain of its authenticity. Any risks or issues arising from viewing this content are solely your responsibility, not Functionland's or the Fula Network's.</p>
        <p>CID: <code>${safeCidHtml}</code></p>
        <div class="btns">
          <button class="btn btn-secondary" id="disagreeBtn" type="button">I Disagree</button>
          <button class="btn btn-primary"   id="agreeBtn"    type="button">I Agree</button>
        </div>
        <button class="remember" id="rememberBtn" type="button">I Agree and do not show this warning for this content again</button>
      </div>
      <div id="blocked" class="blocked" style="display:none">
        <h1>Blocked by you</h1>
        <p>You chose not to view this content. Close this tab or navigate away.</p>
      </div>
    </div>
  </div>
</div>
<script>
(function () {
  var CID = ${cidJson};
  // v2 key — v1 entries (if any) are orphaned on purpose: the v1 sandbox let
  // iframe content write to parent.localStorage, so pre-existing "remembered"
  // CIDs can't be trusted. Starting fresh forces a re-consent pass.
  var KEY = 'fula_gateway_agreed_cids_v2';
  var MAX = 500;
  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }
  function write(list) {
    try {
      if (list.length > MAX) list = list.slice(-MAX);
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (_) {}
  }
  function remember(cid) {
    var list = read();
    if (list.indexOf(cid) === -1) list.push(cid);
    write(list);
  }
  var wrap = document.getElementById('wrap');
  var overlay = document.getElementById('overlay');
  var disclaimer = document.getElementById('disclaimer');
  var blocked = document.getElementById('blocked');
  function accept() { wrap.classList.add('ok'); overlay.classList.add('hidden'); }
  function deny() { disclaimer.style.display = 'none'; blocked.style.display = 'block'; }

  if (read().indexOf(CID) !== -1) { accept(); return; }

  document.getElementById('agreeBtn').addEventListener('click', accept);
  document.getElementById('disagreeBtn').addEventListener('click', deny);
  document.getElementById('rememberBtn').addEventListener('click', function () { remember(CID); accept(); });
})();
</script>
</body>
</html>`;
}

module.exports = { renderWrapper, buildIframeQuery };
