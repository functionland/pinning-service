/**
 * IPFS Service
 *
 * Publishes generated website files via the S3 gateway (fula-api) for storage
 * and cluster pinning. HTML files are rewritten so relative asset references
 * point to absolute gateway CID URLs, eliminating the need for directory CIDs.
 */

import { config } from '../config/index.js';

export interface PublishResult {
  cid: string;
  gatewayUrl: string;
}

const MAX_RETRIES = 1;
const UPLOAD_CONCURRENCY = 5;
const OVERALL_TIMEOUT_MS = 120_000;

// Content-type map for common website file extensions
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.xml': 'text/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getContentType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

async function ensureBucket(userToken: string, signal: AbortSignal): Promise<void> {
  const url = `${config.s3GatewayUrl}/${config.s3BucketName}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userToken}` },
    signal,
  });

  // 200 = created, 409 = already exists — both are fine
  if (!res.ok && res.status !== 409) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to ensure S3 bucket: ${res.status} ${body}`);
  }

  console.log(`[ipfs] S3 bucket "${config.s3BucketName}" ready`);
}

interface UploadedFile {
  path: string;
  cid: string;
  s3Key: string;
}

/**
 * Upload a single file to the S3 gateway with retry.
 */
async function uploadFileToS3(
  file: { path: string; content: string },
  jobId: string,
  userToken: string,
  signal: AbortSignal
): Promise<UploadedFile> {
  const s3Key = `website-${jobId}/${file.path}`;
  const url = `${config.s3GatewayUrl}/${config.s3BucketName}/${s3Key}`;
  const body = new TextEncoder().encode(file.content);
  const contentType = getContentType(file.path);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[ipfs] Retrying S3 upload for ${file.path} (attempt ${attempt + 1})...`);
    }

    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': contentType,
        },
        body,
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`S3 PUT ${s3Key} failed: ${res.status} ${errBody}`);
      }

      // Extract CID from ETag header (strip quotes)
      const etag = res.headers.get('etag') || '';
      const cid = etag.replace(/"/g, '');
      if (!cid) {
        throw new Error(`S3 PUT ${s3Key}: no CID in ETag header`);
      }

      return { path: file.path, cid, s3Key };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isNetworkError =
        lastError.message.includes('ECONNREFUSED') ||
        lastError.message.includes('ECONNRESET') ||
        lastError.message.includes('ETIMEDOUT') ||
        lastError.message.includes('fetch failed');

      if (!isNetworkError || attempt >= MAX_RETRIES) {
        break;
      }
    }
  }

  throw lastError!;
}

/**
 * Run promises with limited concurrency.
 */
async function parallelLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Attempt to clean up uploaded S3 objects on failure.
 */
async function cleanupS3(uploadedKeys: string[], userToken: string): Promise<void> {
  if (uploadedKeys.length === 0) return;

  try {
    // Delete objects one by one (simple approach, fire-and-forget)
    for (const key of uploadedKeys) {
      const url = `${config.s3GatewayUrl}/${config.s3BucketName}/${key}`;
      await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userToken}` },
      }).catch(() => {});
    }
    console.log(`[ipfs] Cleaned up ${uploadedKeys.length} S3 objects`);
  } catch {
    console.warn('[ipfs] S3 cleanup failed (non-critical)');
  }
}

/**
 * Rewrite HTML content, replacing relative asset paths with absolute gateway URLs.
 */
function rewriteHtml(html: string, cidMap: Record<string, string>): string {
  let result = html;
  for (const [path, url] of Object.entries(cidMap)) {
    result = result.replaceAll(`./${path}`, url);
    result = result.replaceAll(`"${path}"`, `"${url}"`);
    result = result.replaceAll(`'${path}'`, `'${url}'`);
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inline generated .css/.js files into an HTML page, replacing their
 * <link rel=stylesheet>/<script src> tags with <style>/<script> blocks.
 *
 * WHY: assets are served by BARE CID, so the gateway cannot know their MIME
 * type — it responds `text/plain` with `X-Content-Type-Options: nosniff`,
 * and browsers hard-refuse non-`text/css` stylesheets and non-JS scripts
 * (site renders unstyled with dead JS). Inlining makes the shipped page
 * self-contained and immune to gateway MIME behavior.
 * Returns the rewritten page and which file paths were inlined.
 */
function inlineLocalCssJs(
  html: string,
  files: Array<{ path: string; content: string }>,
): { html: string; inlined: Set<string> } {
  let result = html;
  const inlined = new Set<string>();
  for (const file of files) {
    const p = escapeRegExp(file.path);
    // href/src may be "./path" or "path", any attribute order/quotes.
    const ref = `(?:\\./)?${p}`;
    if (file.path.toLowerCase().endsWith('.css')) {
      const linkRe = new RegExp(`<link\\b[^>]*href=["']${ref}["'][^>]*>`, 'gi');
      if (linkRe.test(result)) {
        // "</style" cannot appear in valid CSS; defuse it defensively.
        const css = file.content.replace(/<\/style/gi, '<\\/style');
        result = result.replace(linkRe, `<style>\n${css}\n</style>`);
        inlined.add(file.path);
      }
    } else if (file.path.toLowerCase().endsWith('.js')) {
      const scriptRe = new RegExp(
        `<script\\b[^>]*src=["']${ref}["'][^>]*>\\s*</script>`,
        'gi',
      );
      if (scriptRe.test(result)) {
        // Standard inline-script escape: "</script" inside strings/regexes.
        const js = file.content.replace(/<\/script/gi, '<\\/script');
        result = result.replace(scriptRe, `<script>\n${js}\n</script>`);
        inlined.add(file.path);
      }
    }
  }
  return { html: result, inlined };
}

/** data: URI for a generated SVG — <img> requires image/svg+xml, which a
 *  bare-CID gateway response can never carry. */
function svgDataUri(content: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(content, 'utf-8').toString('base64')}`;
}

/**
 * Build the fxfiles-analytics injection snippet. The injected script
 * self-discovers the IPFS CID from `window.location` (handles
 * subdomain-style `{cid}.ipfs.<gateway>` and path-style
 * `<gateway>/ipfs/{cid}/`) and POSTs a pageview ping. No cookies, no
 * localStorage, no PII collection. Content-Type is `text/plain` so the
 * request is CORS-safelisted and survives `sendBeacon` / `no-cors fetch`.
 */
function buildAnalyticsScript(endpoint: string): string {
  // Trim a trailing slash so `${endpoint}/api/v1/track` doesn't double up.
  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  return `<script>
(function () {
  var ENDPOINT = ${JSON.stringify(base + '/api/v1/track')};
  try {
    var cid = '';
    var parts = location.hostname.split('.');
    if (parts.length >= 3 && parts[1] === 'ipfs') {
      cid = parts[0];
    } else {
      var m = location.pathname.match(/^\\/ipfs\\/([^\\/]+)/);
      if (m) cid = m[1];
    }
    if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[ykz][a-z0-9]{40,80})$/.test(cid)) return;
    var data = JSON.stringify({
      cid: cid,
      event: 'pageview',
      ref: (document.referrer || '').slice(0, 200)
    });
    var blob = new Blob([data], { type: 'text/plain' });
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: data,
      keepalive: true,
      mode: 'no-cors'
    }).catch(function () {});
  } catch (e) {}
})();
</script>`;
}

/**
 * Insert the analytics snippet just before `</body>`, or append it to the
 * end of the document if the closing tag is missing. Case-insensitive match
 * on the closing tag.
 */
function injectAnalyticsScript(html: string, snippet: string): string {
  const closingBodyRe = /<\/body\s*>/i;
  if (closingBodyRe.test(html)) {
    return html.replace(closingBodyRe, `${snippet}\n$&`);
  }
  return html + '\n' + snippet + '\n';
}

/**
 * Publish website files via S3 gateway with URL rewriting.
 *
 * 1. Upload non-HTML assets to S3 → collect CID map
 * 2. Rewrite HTML to replace relative paths with absolute gateway CID URLs
 * 3. Upload rewritten HTML to S3 → return its CID as the website URL
 *
 * All files go through S3 for proper cluster replication and pinning.
 * No direct IPFS API calls are made.
 */
export interface PublishOptions {
  enableTracking?: boolean;
}

export async function publishWebsite(
  files: Array<{ path: string; content: string }>,
  jobId: string,
  userToken: string,
  options: PublishOptions = {}
): Promise<PublishResult> {
  console.log(`[ipfs] Publishing ${files.length} files via S3 gateway with URL rewriting...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS);
  const uploadedKeys: string[] = [];

  const gatewayBase = config.ipfsGatewayUrl.endsWith('/')
    ? config.ipfsGatewayUrl.slice(0, -1)
    : config.ipfsGatewayUrl;

  try {
    await ensureBucket(userToken, controller.signal);

    // Partition: index.html entry point, other .html pages (rewritten AND
    // added to the cid map so index links resolve — subpage→index links
    // cannot resolve under content addressing, which is why the prompts
    // mandate single-page output; this is defense for accidental
    // multi-page sites), and non-HTML assets.
    const indexFile = files.find(f => f.path === 'index.html');
    const subPages = files.filter(
      f => f.path !== 'index.html' && f.path.toLowerCase().endsWith('.html')
    );
    const otherFiles = files.filter(
      f => f.path !== 'index.html' && !f.path.toLowerCase().endsWith('.html')
    );

    if (!indexFile) {
      throw new Error('No index.html found in generated files');
    }

    // Step 0: Inline generated CSS/JS into every HTML page (bare-CID
    // gateway responses are text/plain + nosniff, so external stylesheet/
    // script tags would be MIME-refused by browsers — the "unstyled page,
    // dead JS" failure). Generated SVGs become data: URIs for the same
    // reason. Inlined files are not uploaded separately.
    const inlineable = otherFiles.filter((f) => {
      const p = f.path.toLowerCase();
      return p.endsWith('.css') || p.endsWith('.js');
    });
    const inlinedEverywhere = new Set<string>();
    const inlinePage = (html: string): string => {
      const r = inlineLocalCssJs(html, inlineable);
      for (const p of r.inlined) {
        inlinedEverywhere.add(p);
      }
      return r.html;
    };
    const indexHtmlInlined = inlinePage(indexFile.content);
    const subPagesInlined = subPages.map((page) => ({
      path: page.path,
      content: inlinePage(page.content),
    }));

    // Step 1: Upload remaining non-HTML assets, collect path → URL map.
    // SVGs ride along as data: URIs instead of uploads.
    const cidMap: Record<string, string> = {};
    const uploadable: typeof otherFiles = [];
    for (const file of otherFiles) {
      const lower = file.path.toLowerCase();
      if (inlinedEverywhere.has(file.path)) continue; // now inline
      if (lower.endsWith('.svg')) {
        cidMap[file.path] = svgDataUri(file.content);
        continue;
      }
      uploadable.push(file);
    }

    if (uploadable.length > 0) {
      console.log(`[ipfs] Uploading ${uploadable.length} asset files to S3...`);
      const uploadTasks = uploadable.map((file) => () =>
        uploadFileToS3(file, jobId, userToken, controller.signal).then((result) => {
          uploadedKeys.push(result.s3Key);
          cidMap[file.path] = `${gatewayBase}/${result.cid}`;
          return result;
        })
      );
      await parallelLimit(uploadTasks, UPLOAD_CONCURRENCY);
      console.log(`[ipfs] Asset uploads complete`);
    }
    if (inlinedEverywhere.size > 0) {
      console.log(
        `[ipfs] Inlined into HTML: ${[...inlinedEverywhere].join(', ')}`,
      );
    }

    // Step 1.5: Rewrite + upload each subpage (its asset refs now resolve),
    // then add its CID to the map so index→subpage links resolve too.
    for (const page of subPagesInlined) {
      const rewrittenPage = rewriteHtml(page.content, cidMap);
      const uploaded = await uploadFileToS3(
        { path: page.path, content: rewrittenPage },
        jobId,
        userToken,
        controller.signal
      );
      uploadedKeys.push(uploaded.s3Key);
      cidMap[page.path] = `${gatewayBase}/${uploaded.cid}`;
      console.log(`[ipfs] Subpage ${page.path} → ${uploaded.cid}`);
    }

    // Step 2: Rewrite index.html with absolute gateway URLs
    let rewrittenHtml = rewriteHtml(indexHtmlInlined, cidMap);

    // Step 2.5 (optional): Inject the fxfiles-analytics ping script. The
    // user opted in via `enableTracking` at generate time; the script
    // self-discovers the CID from window.location at runtime.
    if (options.enableTracking) {
      const snippet = buildAnalyticsScript(config.analyticsEndpointUrl);
      rewrittenHtml = injectAnalyticsScript(rewrittenHtml, snippet);
      console.log('[ipfs] Click-tracking script injected into index.html');
    }

    // Step 3: Upload rewritten index.html
    console.log('[ipfs] Uploading rewritten index.html...');
    const indexUploaded = await uploadFileToS3(
      { path: 'index.html', content: rewrittenHtml },
      jobId,
      userToken,
      controller.signal
    );
    uploadedKeys.push(indexUploaded.s3Key);

    const gatewayUrl = `${gatewayBase}/${indexUploaded.cid}`;

    console.log(`[ipfs] Published HTML CID: ${indexUploaded.cid}`);
    console.log(`[ipfs] Gateway URL: ${gatewayUrl}`);

    return { cid: indexUploaded.cid, gatewayUrl };
  } catch (error) {
    await cleanupS3(uploadedKeys, userToken);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
