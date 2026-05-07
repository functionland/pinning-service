/**
 * Claude Service
 *
 * Uses Anthropic SDK to generate website files via Claude API.
 *
 * Asset handling: each asset URL is fetched into the per-job tmpDir, then
 * forwarded to Claude as the most native content block we can build for that
 * file type:
 *   - PNG/JPEG/GIF/WebP → base64 image block
 *   - PDF                → base64 document block
 *   - DOCX               → mammoth-extracted text wrapped in a text-source
 *                          document block (titled with the original filename)
 *   - XLSX/PPTX          → officeparser-extracted text wrapped likewise
 *   - txt/md/csv/json/html/xml → utf-8 text wrapped likewise
 *   - anything else      → no block; URL/description in the prompt is the only
 *                          reference Claude gets
 * Tmp-file cleanup is handled by the caller (executeJob's finally rmSync
 * of tmpDir) on both success and failure.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import { parseOfficeAsync } from 'officeparser';
import { config } from '../config/index.js';

export interface WebsiteFile {
  path: string;
  content: string;
}

interface ClaudeResponse {
  files: WebsiteFile[];
}

interface Asset {
  fileName: string;
  type: string;
  url: string;
  content?: string;
}

type DocumentBlockParam = Anthropic.DocumentBlockParam;
type ImageBlockParam = Anthropic.ImageBlockParam;
type TextBlockParam = Anthropic.TextBlockParam;
type AssetContentBlock = DocumentBlockParam | ImageBlockParam;

/** Result of trying to attach a single asset as a Claude content block. */
interface AssetAttach {
  block?: AssetContentBlock;
  /** Human-readable reason; surfaced as a note in the user-message text so
   *  Claude knows the URL line is the only reference it has. */
  error?: string;
}

const FETCH_TIMEOUT_MS = 45_000;
/** Anthropic per-file ceiling (PDF cap; images cap at 5MB but the app has
 *  already enforced both, so this is just defence in depth on the network). */
const MAX_FETCH_BYTES = 32 * 1024 * 1024;

const SYSTEM_PROMPT = `You are a website builder. Generate a complete static website as a set of files.
Return ONLY a JSON object with this structure:
{ "files": [ { "path": "index.html", "content": "..." }, { "path": "style.css", "content": "..." } ] }

CRITICAL — This website will be hosted on IPFS (a decentralized static file system). You MUST follow these rules:

File paths:
- Always include index.html as the entry point
- File paths must be simple names or single-level subdirectories (e.g., "style.css", "js/main.js", "images/hero.svg")
- NEVER use absolute paths starting with / — IPFS serves files under a subpath like /ipfs/CID/website/
- NEVER use paths with ".." or any directory traversal
- All internal references (CSS, JS, images) MUST use relative paths: href="./style.css" or src="./js/main.js"

Assets:
- Reference provided asset URLs directly in HTML using their full URLs (img src="https://...", video src="https://...")
- These are external assets already hosted — use the URLs exactly as given

Content:
- Use modern, responsive CSS with clean typography
- Keep it self-contained — inline or separate CSS/JS files, NO external CDN links
- Generate clean, valid HTML5
- Make the design visually appealing with good use of whitespace and color
- Ensure mobile responsiveness
- No server-side features (no PHP, no SSR, no APIs, no forms with action URLs) — purely static HTML/CSS/JS
- JavaScript is fine for client-side interactivity (animations, galleries, tabs, etc.)

Output:
- Do NOT wrap the JSON in markdown code blocks — return raw JSON only
- Keep total output under 50 files`;

const client = new Anthropic({
  apiKey: config.claudeApiKey,
});

// =============================================================================
// Asset fetch + content-block builder
// =============================================================================

interface MediaInfo {
  kind: 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'unknown';
  imageMime?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

function detectMedia(fileName: string): MediaInfo {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png':
      return { kind: 'image', imageMime: 'image/png' };
    case '.jpg':
    case '.jpeg':
      return { kind: 'image', imageMime: 'image/jpeg' };
    case '.gif':
      return { kind: 'image', imageMime: 'image/gif' };
    case '.webp':
      return { kind: 'image', imageMime: 'image/webp' };
    case '.pdf':
      return { kind: 'pdf' };
    case '.docx':
      return { kind: 'docx' };
    case '.xlsx':
      return { kind: 'xlsx' };
    case '.pptx':
      return { kind: 'pptx' };
    case '.txt':
    case '.md':
    case '.csv':
    case '.json':
    case '.html':
    case '.htm':
    case '.xml':
      return { kind: 'text' };
    default:
      return { kind: 'unknown' };
  }
}

/** Sanitize a filename for safe use as a tmp-path basename. */
function safeBasename(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'asset';
}

/** Fetch a URL into [destPath], 45s timeout, one retry, cap MAX_FETCH_BYTES. */
async function fetchToFile(
  url: string,
  destPath: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    signal?.addEventListener('abort', onParentAbort);
    const timeoutId = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FETCH_BYTES) {
        throw new Error(`file too large: ${buf.length} bytes (cap ${MAX_FETCH_BYTES})`);
      }
      fs.writeFileSync(destPath, buf);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (signal?.aborted) {
        throw lastErr;
      }
      if (attempt === 0) {
        console.warn(`[claude] fetch retry for ${url}: ${lastErr.message}`);
      }
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

/** Download an asset to tmpDir and build the appropriate Claude content block. */
async function attachAsset(
  asset: Asset,
  tmpDir: string,
  signal?: AbortSignal,
): Promise<AssetAttach> {
  const media = detectMedia(asset.fileName);
  if (media.kind === 'unknown') {
    return { error: `unsupported file extension: ${path.extname(asset.fileName) || '(none)'}` };
  }

  const tmpPath = path.join(tmpDir, `${Date.now()}-${safeBasename(asset.fileName)}`);
  try {
    await fetchToFile(asset.url, tmpPath, signal);
  } catch (err) {
    return { error: `download failed: ${(err as Error).message}` };
  }

  try {
    if (media.kind === 'image') {
      const data = fs.readFileSync(tmpPath).toString('base64');
      return {
        block: {
          type: 'image',
          source: { type: 'base64', media_type: media.imageMime!, data },
        },
      };
    }
    if (media.kind === 'pdf') {
      const data = fs.readFileSync(tmpPath).toString('base64');
      return {
        block: {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
          title: asset.fileName,
        },
      };
    }
    if (media.kind === 'docx') {
      const result = await mammoth.extractRawText({ path: tmpPath });
      const text = (result.value || '').trim();
      if (!text) {
        return { error: 'docx contained no extractable text' };
      }
      return {
        block: {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: text },
          title: asset.fileName,
        },
      };
    }
    if (media.kind === 'xlsx' || media.kind === 'pptx') {
      const text = (await parseOfficeAsync(tmpPath)).trim();
      if (!text) {
        return { error: `${media.kind} contained no extractable text` };
      }
      return {
        block: {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: text },
          title: asset.fileName,
        },
      };
    }
    if (media.kind === 'text') {
      const text = fs.readFileSync(tmpPath, 'utf-8');
      return {
        block: {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: text },
          title: asset.fileName,
        },
      };
    }
    return { error: 'unhandled media kind' };
  } catch (err) {
    return { error: `extraction failed: ${(err as Error).message}` };
  }
  // No tmpPath unlink here — executeJob's finally rmSync(tmpDir) cleans
  // every staged file on both success and failure.
}

// =============================================================================
// Main entry
// =============================================================================

/**
 * Generate website files using Claude API.
 *
 * @param tmpDir Per-job temp directory (created by executeJob, removed in
 *               its finally block). Used to stage downloaded assets.
 */
export async function generateWebsite(
  prompt: string,
  assets: Asset[],
  signal?: AbortSignal,
  tmpDir?: string,
): Promise<WebsiteFile[]> {
  // Try to download + attach every asset. Errors are captured per-asset so
  // a single bad file doesn't fail the whole generation — Claude still has
  // the URL+description line as a fallback.
  const attached: Array<{ asset: Asset; result: AssetAttach }> = [];
  if (assets.length > 0) {
    if (!tmpDir) {
      console.warn('[claude] no tmpDir provided — skipping asset attachment');
      for (const asset of assets) {
        attached.push({ asset, result: { error: 'backend tmp dir unavailable' } });
      }
    } else {
      // Defensive: tmpDir should already exist (executeJob created it).
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch {
        /* ignore — already exists */
      }
      for (const asset of assets) {
        if (signal?.aborted) {
          attached.push({ asset, result: { error: 'job aborted' } });
          continue;
        }
        const result = await attachAsset(asset, tmpDir, signal);
        attached.push({ asset, result });
        if (result.error) {
          console.warn(`[claude] asset ${asset.fileName} not attached: ${result.error}`);
        }
      }
    }
  }

  // Build the user-message text. URL+description lines are kept for ALL
  // assets (including successfully attached ones) as a backup reference, per
  // the project's preference.
  let userMessage = `Create a website with the following requirements:\n\n${prompt}`;
  if (attached.length > 0) {
    userMessage += '\n\nAvailable assets (use these URLs directly in the HTML):';
    for (const { asset, result } of attached) {
      userMessage += `\n- ${asset.fileName} (${asset.type}): ${asset.url}`;
      if (asset.content) {
        userMessage += `\n  Content description: ${asset.content}`;
      }
      if (result.block) {
        userMessage += `\n  (also attached as a ${result.block.type} block titled "${asset.fileName}")`;
      } else if (result.error) {
        userMessage += `\n  (note: file was NOT attached as a block — ${result.error}; use the URL above)`;
      }
    }
  }

  const messageContent: Array<TextBlockParam | AssetContentBlock> = [
    { type: 'text', text: userMessage },
  ];
  for (const { result } of attached) {
    if (result.block) {
      messageContent.push(result.block);
    }
  }

  const attachedCount = attached.filter((a) => a.result.block).length;
  console.log(
    `[claude] Generating: ${assets.length} assets (${attachedCount} attached as blocks), model: ${config.claudeModel}`,
  );

  let response: Anthropic.Message;
  try {
    const stream = client.messages.stream(
      {
        model: config.claudeModel,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: messageContent }],
      },
      { signal },
    );
    response = await stream.finalMessage();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Generation was cancelled');
    }
    throw error;
  }

  // Extract text content from response
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  const rawText = textBlock.text.trim();

  // Check if response was truncated (hit max_tokens)
  if (response.stop_reason === 'max_tokens') {
    console.warn(`[claude] Response truncated at ${rawText.length} chars (hit max_tokens). stop_reason: ${response.stop_reason}`);
  }

  // Parse JSON response (handle possible markdown code blocks)
  let jsonText = rawText;
  if (jsonText.startsWith('```')) {
    // Strip markdown code fences
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: ClaudeResponse;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseError) {
    // Retry once — ask Claude to fix its output. Reuse the same multi-block
    // user content so it still has the attached files.
    console.warn(`[claude] Failed to parse response (${rawText.length} chars), last 200 chars: ...${rawText.slice(-200)}`);
    console.warn('[claude] Retrying with correction prompt');
    try {
      const retryStream = client.messages.stream(
        {
          model: config.claudeModel,
          max_tokens: 64000,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: messageContent },
            { role: 'assistant', content: rawText },
            {
              role: 'user',
              content:
                'Your previous response was not valid JSON. Please return ONLY a valid JSON object with the structure: { "files": [ { "path": "...", "content": "..." } ] }. No markdown, no explanation — just the JSON.',
            },
          ],
        },
        { signal },
      );
      const retryResponse = await retryStream.finalMessage();

      const retryBlock = retryResponse.content.find((b) => b.type === 'text');
      if (!retryBlock || retryBlock.type !== 'text') {
        throw new Error('Claude retry returned no text');
      }

      let retryText = retryBlock.text.trim();
      if (retryText.startsWith('```')) {
        retryText = retryText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      parsed = JSON.parse(retryText);
    } catch {
      throw new Error(`Failed to parse Claude response as JSON: ${(parseError as Error).message}`);
    }
  }

  // Validate response structure
  if (!parsed.files || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('Claude response missing files array');
  }

  const hasIndex = parsed.files.some((f) => f.path === 'index.html');
  if (!hasIndex) {
    throw new Error('Claude response missing index.html');
  }

  // Validate each file has path and content
  for (const file of parsed.files) {
    if (!file.path || typeof file.content !== 'string') {
      throw new Error(`Invalid file entry: ${JSON.stringify(file).slice(0, 100)}`);
    }
  }

  console.log(`[claude] Generated ${parsed.files.length} files: ${parsed.files.map((f) => f.path).join(', ')}`);

  return parsed.files;
}
