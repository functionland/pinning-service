/**
 * Make a generated site's asset references GATEWAY-AGNOSTIC.
 *
 * The problem: a published site is immutable (content-addressed), so any
 * gateway hostname baked into its HTML is frozen for the life of that site.
 * When dweb.link was retired, every site that had been generated pointing at it
 * lost its images, and no setting anywhere could fix them.
 *
 * The fix: don't name a gateway at all. A site is always served BY some
 * gateway, so a DOCUMENT-RELATIVE reference resolves against whichever one the
 * visitor is using:
 *
 *   page  https://ipfs.filebase.io/ipfs/<pageCid>/      ../<cid> -> /ipfs/<cid>
 *   page  https://ipfs.cloud.fx.land/gateway/<pageCid>/ ../<cid> -> /gateway/<cid>
 *
 * The same string lands on a different path prefix at each gateway without
 * knowing either — measured working on both, with images loading at identical
 * dimensions. It follows a gateway that does not exist yet, too, which is the
 * point: the gateway becomes a property of how the page is fetched rather than
 * of the page itself.
 *
 * Where relative CANNOT work — a page fetched without a trailing slash, or from
 * a subdomain-style gateway where assets live on another host — the injected
 * fallback chain (see buildAssetFallbackScript) recovers the image from an
 * absolute gateway instead.
 */

/**
 * A CID as it appears in a URL: a long alphanumeric run ending the segment.
 * Covers CIDv1 base32 (`bafy…`) and CIDv0 base58 (`Qm…`). Anchoring on the
 * segment end stops it matching a stray `ba` inside a hostname like
 * `ipfs.filebase.io`.
 */
const CID_IN_URL = /([A-Za-z0-9]{40,120})(?:[/?#]|$)/;

/** Attributes that legitimately carry a single URL. `content` is NOT here —
 *  og:/twitter: previews must stay absolute (crawlers do not run JS). */
const URL_ATTR_RE = /\b(src|href|poster)\s*=\s*(["'])([^"']*)\2/gi;
const SRCSET_RE = /\bsrcset\s*=\s*(["'])([^"']*)\1/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_ATTR_RE = /\bstyle\s*=\s*(["'])([^"']*)\1/gi;
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/** The relative form of an asset reference. */
export function relativeAssetRef(cid: string): string {
  return `../${cid}`;
}

/**
 * The relative form of a link to another PAGE — same as an asset, plus a
 * trailing slash.
 *
 * Every page is its own CID here, so a link of `../<cid>` lands the visitor at
 * `/ipfs/<cid>` with no trailing slash, and THAT page's own `../<asset>`
 * references then resolve one level too high and fall back to an absolute
 * gateway. The slash keeps a subpage behaving exactly like the entry page:
 * served by, and loading its assets from, the gateway the visitor is using.
 * Gateways serve the slashed form of a bare file fine (verified on both).
 *
 * Assets deliberately do NOT get this — they are files, not directories.
 */
export function relativePageRef(cid: string): string {
  return `../${cid}/`;
}

/**
 * Pull the CID out of a gateway-shaped URL, or null.
 *
 * Structural, not a hostname allowlist: the CID must sit directly after an
 * `ipfs`/`gateway` path segment, or be the label before `.ipfs.` in a
 * subdomain. That means a NEW gateway is handled without a code change, while
 * an ordinary link (`https://example.com/about`) is never touched.
 */
function gatewayCid(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const ipfsIdx = url.hostname.indexOf('.ipfs.');
  if (ipfsIdx > 0) {
    const label = url.hostname.slice(0, ipfsIdx);
    if (/^[A-Za-z0-9]{40,120}$/.test(label)) return label;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (!/^[A-Za-z0-9]{40,120}$/.test(segments[i])) continue;
    const prev = i > 0 ? segments[i - 1] : '';
    if (prev === 'ipfs' || prev === 'gateway') return segments[i];
  }
  return null;
}

/**
 * CID directly under one of OUR configured gateway bases.
 *
 * The structural rule above keys on an `ipfs`/`gateway` path segment, which
 * covers filebase and most public gateways — but a deployment may configure its
 * own gateway as a bare base (`https://host` → `https://host/<cid>`), where
 * there is no such segment to key on. Matching the configured base explicitly
 * handles that without loosening the structural rule into "any long path
 * segment is a CID", which would risk rewriting unrelated links.
 */
function cidUnderKnownBase(raw: string, bases: string[]): string | null {
  for (const base of bases) {
    if (!base) continue;
    const prefix = base.endsWith('/') ? base : `${base}/`;
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length).split(/[/?#]/)[0];
    if (/^[A-Za-z0-9]{40,120}$/.test(rest)) return rest;
  }
  return null;
}

/** Rewrite one URL to its relative form, or return null to leave it alone. */
function toRelative(raw: string, bases: string[]): string | null {
  const cid = gatewayCid(raw) ?? cidUnderKnownBase(raw, bases);
  return cid ? relativeAssetRef(cid) : null;
}

function relativizeCssUrls(css: string, bases: string[]): string {
  return css.replace(CSS_URL_RE, (match, quote: string, value: string) => {
    const rel = toRelative(value.trim(), bases);
    return rel ? `url(${quote}${rel}${quote})` : match;
  });
}

/**
 * Rewrite absolute gateway URLs in the finished HTML to the relative form.
 *
 * This is the DETERMINISTIC half of the design: the model is also asked to emit
 * relative references, but asking is not a guarantee, and a single absolute URL
 * that slips through is a dead image the day that gateway retires. Running this
 * over the finished page makes the outcome independent of what the model did.
 *
 * ATTRIBUTE-SCOPED, deliberately. A blanket string replace would also rewrite a
 * gateway URL sitting in visible copy ("find it at https://…"), in inline JSON,
 * or in a `twitter:image` tag — corrupting content and breaking previews. Only
 * positions that actually carry a URL are touched.
 */
export function relativizeGatewayUrls(
  html: string,
  knownBases: string[] = [],
): string {
  let out = html.replace(
    URL_ATTR_RE,
    (match, attr: string, quote: string, value: string) => {
      const rel = toRelative(value, knownBases);
      return rel ? `${attr}=${quote}${rel}${quote}` : match;
    },
  );

  // srcset is a comma-separated list of "url descriptor" pairs.
  out = out.replace(SRCSET_RE, (match, quote: string, value: string) => {
    const rewritten = value
      .split(',')
      .map((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return entry;
        const [url, ...descriptor] = trimmed.split(/\s+/);
        const rel = toRelative(url, knownBases);
        return rel ? [rel, ...descriptor].join(' ') : trimmed;
      })
      .join(', ');
    return `srcset=${quote}${rewritten}${quote}`;
  });

  out = out.replace(STYLE_BLOCK_RE, (match, css: string) =>
    match.replace(css, relativizeCssUrls(css, knownBases)),
  );
  out = out.replace(
    STYLE_ATTR_RE,
    (_match, quote: string, value: string) =>
      `style=${quote}${relativizeCssUrls(value, knownBases)}${quote}`,
  );

  return out;
}

/**
 * Put social-preview images back to an absolute URL.
 *
 * Crawlers do not run JavaScript and do not resolve a relative `og:image`, so
 * a preview must name a gateway even though the page body does not. Uses the
 * SERVICE default rather than whatever the user picked: a user on a custom or
 * dying gateway would otherwise freeze dead previews into every site they make.
 * If that gateway is later retired only the preview thumbnail is affected —
 * the site itself keeps working.
 */
export function absolutizeSocialMeta(html: string, gatewayBase: string): string {
  const base = gatewayBase.endsWith('/') ? gatewayBase.slice(0, -1) : gatewayBase;
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (
      !/(?:property|name)\s*=\s*["'](?:og:image|twitter:image(?::src)?)["']/i.test(
        tag,
      )
    ) {
      return tag;
    }
    return tag.replace(
      /\bcontent\s*=\s*(["'])([^"']*)\1/i,
      (match, quote: string, value: string) => {
        if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) return match;
        const cid = value.match(CID_IN_URL);
        return cid ? `content=${quote}${base}/${cid[1]}${quote}` : match;
      },
    );
  });
}

/**
 * Inline script that recovers an image when the relative reference cannot
 * resolve — a page opened without its trailing slash, or served from a
 * subdomain-style gateway where the assets are on another host.
 *
 * Injected into <head>, NOT before </body> like the analytics snippet: an
 * `error` listener registered at the end of the document misses images that
 * already failed while parsing, and error events do not replay. The
 * DOMContentLoaded sweep is the belt to that braces, catching anything that
 * failed even before this ran.
 *
 * The attempt counter is not optional. Assigning `src` from inside an error
 * handler re-triggers `error` on the next failure, so without a hard stop at
 * the end of the chain this becomes an unbounded retry loop that floods the
 * network and can lock the tab up.
 */
export function buildAssetFallbackScript(chain: string[]): string {
  const bases = chain
    .map((base) => (base.endsWith('/') ? base : `${base}/`))
    .filter((base, i, all) => all.indexOf(base) === i);

  return `<script>
(function () {
  var CHAIN = ${JSON.stringify(bases)};
  var CID = /([A-Za-z0-9]{40,120})(?:[\\/?#]|$)/;
  function retry(el) {
    if (!el || el.tagName !== 'IMG') return;
    var tried = parseInt(el.getAttribute('data-fx-try') || '0', 10);
    if (!(tried < CHAIN.length)) return;
    var m = String(el.getAttribute('src') || '').match(CID);
    if (!m) { el.setAttribute('data-fx-try', String(CHAIN.length)); return; }
    el.setAttribute('data-fx-try', String(tried + 1));
    el.src = CHAIN[tried] + m[1];
  }
  document.addEventListener('error', function (e) { retry(e.target); }, true);
  document.addEventListener('DOMContentLoaded', function () {
    var imgs = document.getElementsByTagName('img');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete && imgs[i].naturalWidth === 0) retry(imgs[i]);
    }
  });
})();
</script>`;
}

/**
 * Insert a snippet at the START of <head> so it runs before any <img> is
 * parsed. Falls back to prepending when the document has no head.
 */
export function injectIntoHead(html: string, snippet: string): string {
  const headOpen = /<head\b[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (tag) => `${tag}\n${snippet}`);
  }
  const htmlOpen = /<html\b[^>]*>/i;
  if (htmlOpen.test(html)) {
    return html.replace(htmlOpen, (tag) => `${tag}\n${snippet}`);
  }
  return `${snippet}\n${html}`;
}
