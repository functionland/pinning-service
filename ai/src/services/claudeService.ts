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
import sharp from 'sharp';
import { config } from '../config/index.js';
import {
  DESIGN_SKILL_SHA256,
  DESIGN_SKILL_UPSTREAM_COMMIT,
} from '../prompts/designSkill.js';
import {
  BRIEF_PASS_INSTRUCTION,
  BUILD_PASS_INSTRUCTION,
  POLISH_PASS_INSTRUCTION,
  TRUNCATION_RETRY_INSTRUCTION,
  composeSharedSystemBlocks,
} from '../prompts/passPrompts.js';
import {
  hasLegacyConstraintsBlock,
  stripLegacyConstraintsBlock,
} from '../prompts/promptCompat.js';
import { fetchToFile } from '../utils/fetchFile.js';

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
  /** Positive embedding instruction (e.g. for video, which is referenced by
   *  URL only and never downloaded) — surfaced as a note in the user message. */
  note?: string;
}

// Download timeout/byte-cap semantics live in utils/fetchFile.ts (shared
// with the social-post pipeline); defaults there are 45s / 32MB.
/** Cumulative budget for asset content attached to the request as blocks
 *  (base64/text characters ≈ wire bytes). The Messages API caps requests
 *  at 32MB; with up to 30 assets allowed, attachments must be bounded —
 *  assets beyond the budget stay hosted and URL-referenced (the model
 *  still places them in the HTML; it just doesn't see their content). */
export const MAX_TOTAL_ATTACH_BYTES = 24 * 1024 * 1024;
/** Images larger than this (or wider/taller than the max dimension) are
 *  downscaled for ATTACHMENT ONLY — the hosted original the generated
 *  site references stays full-resolution. The model only needs to SEE the
 *  image to art-direct; ~2576px long edge is Claude's high-res ceiling. */
const IMG_ATTACH_MAX_BYTES = 1_500_000;
const IMG_ATTACH_MAX_DIM = 2576;
/** Extracted document text is clipped to keep any single doc from eating
 *  the whole attachment budget. */
const MAX_DOC_TEXT_CHARS = 150_000;
/** PDFs above this attach as extracted TEXT instead of base64 (the API
 *  caps requests at 32MB and PDFs at ~100 pages anyway). */
const PDF_ATTACH_MAX_BYTES = 15 * 1024 * 1024;

function clipDocText(text: string): string {
  return text.length > MAX_DOC_TEXT_CHARS
    ? `${text.slice(0, MAX_DOC_TEXT_CHARS)}\n…[truncated]`
    : text;
}

/** Structured-output schema for file-producing passes — the API then
 *  GUARANTEES syntactically valid JSON of this shape, eliminating the
 *  parse-failure → repair-retry path in the common case. */
const FILES_JSON_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['files'],
  additionalProperties: false,
};

/** Wire size of an attached block's payload (base64 or text characters). */
function blockWireBytes(block: AssetContentBlock): number {
  const source = block.source as { data?: unknown };
  return typeof source.data === 'string' ? source.data.length : 0;
}

const BASE_SYSTEM_PROMPT = `You are a website builder. Generate a complete static website as a set of files.
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
- Reference provided asset URLs directly using their full URLs (they are already hosted — use them exactly as given).
- IMAGES: <img src="https://..." style="max-width:100%">. VIDEOS (asset type "video"): embed an HTML5 player, NEVER an <img> — <video controls preload="metadata" playsinline style="max-width:100%;height:auto"><source src="https://..." type="video/mp4"></video> (match the <source> type to the file extension).
- The site must otherwise be fully self-contained (no external scripts, styles, fonts, or images). The SINGLE permitted external resource is a YouTube/Vimeo video iframe: if the request references a youtube.com/youtu.be or vimeo.com link, embed a RESPONSIVE 16:9 iframe whose src is EXACTLY https://www.youtube.com/embed/<id> or https://player.vimeo.com/video/<id> (no other host), wrapped in a container with aspect-ratio:16/9 and using loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen. If the link is neither YouTube nor Vimeo, do not embed it.

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

// Compose once at process startup. When enabled, a missing or modified skill
// fails startup rather than silently producing websites without the requested
// design guidance. CLAUDE_DESIGN_SKILL_ENABLED=false is the explicit rollback.
// One shared system prefix serves every pass (and every concurrent job) with
// a cache_control breakpoint at its end, so passes B/C read it from cache.
const SYSTEM_BLOCKS = composeSharedSystemBlocks(
  BASE_SYSTEM_PROMPT,
  config.claudeDesignSkillEnabled,
);

if (config.claudeDesignSkillEnabled) {
  console.log(
    `[claude] Design skill enabled: commit ${DESIGN_SKILL_UPSTREAM_COMMIT.slice(0, 12)}, sha256 ${DESIGN_SKILL_SHA256.slice(0, 12)}...`,
  );
} else {
  console.warn('[claude] Design skill disabled by CLAUDE_DESIGN_SKILL_ENABLED=false');
}

const client = new Anthropic({
  apiKey: config.claudeApiKey,
});

// =============================================================================
// Asset fetch + content-block builder
// =============================================================================

interface MediaInfo {
  kind: 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'video' | 'unknown';
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
    // Browser-playable video — referenced by URL only, never downloaded.
    case '.mp4':
    case '.m4v':
    case '.mov':
    case '.webm':
    case '.ogv':
      return { kind: 'video' };
    default:
      return { kind: 'unknown' };
  }
}

/** Sanitize a filename for safe use as a tmp-path basename. */
function safeBasename(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'asset';
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
  if (media.kind === 'video') {
    // Video is referenced by URL only — never downloaded or attached as a block
    // (a 100MB+ clip would blow MAX_FETCH_BYTES and the request budget). Give
    // Claude a positive embedding instruction rather than an "unsupported" note.
    const vext = path.extname(asset.fileName).toLowerCase();
    const srcType =
      vext === '.webm' ? 'video/webm' : vext === '.ogv' ? 'video/ogg' : 'video/mp4';
    return {
      note:
        'VIDEO asset — embed with an HTML5 player using the URL above, never an <img>: ' +
        '<video controls preload="metadata" playsinline style="max-width:100%;height:auto">' +
        `<source src="URL" type="${srcType}"></video>.`,
    };
  }

  const tmpPath = path.join(tmpDir, `${Date.now()}-${safeBasename(asset.fileName)}`);
  try {
    await fetchToFile(asset.url, tmpPath, signal, { logTag: '[claude]' });
  } catch (err) {
    return { error: `download failed: ${(err as Error).message}` };
  }

  try {
    if (media.kind === 'image') {
      const raw = fs.readFileSync(tmpPath);
      // Large/oversized images are downscaled for the ATTACHMENT copy only
      // (the generated site references the full-resolution hosted URL).
      // This is what lets users attach big photos: the model sees a
      // ~2576px WebP (~200-500KB), never the multi-MB original.
      try {
        const meta = await sharp(tmpPath).metadata();
        const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (raw.length > IMG_ATTACH_MAX_BYTES || longEdge > IMG_ATTACH_MAX_DIM) {
          const resized = await sharp(tmpPath)
            .resize({
              width: IMG_ATTACH_MAX_DIM,
              height: IMG_ATTACH_MAX_DIM,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .webp({ quality: 80 })
            .toBuffer();
          console.log(
            `[claude] ${asset.fileName}: attached downscaled copy (${raw.length} -> ${resized.length} bytes)`,
          );
          return {
            block: {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/webp',
                data: resized.toString('base64'),
              },
            },
            note:
              'a downscaled preview was attached for design reference — the ' +
              'URL above serves the full-resolution original; use the URL in the site.',
          };
        }
      } catch (resizeErr) {
        console.warn(
          `[claude] ${asset.fileName}: resize skipped (${(resizeErr as Error).message})`,
        );
        // Fall through to raw attach if the original is API-safe (<5MB).
        if (raw.length > 5 * 1024 * 1024) {
          return { error: 'image too large to attach and resize failed' };
        }
      }
      return {
        block: {
          type: 'image',
          source: {
            type: 'base64',
            media_type: media.imageMime!,
            data: raw.toString('base64'),
          },
        },
      };
    }
    if (media.kind === 'pdf') {
      const size = fs.statSync(tmpPath).size;
      if (size > PDF_ATTACH_MAX_BYTES) {
        // Too big to ship as base64 — attach the extracted TEXT instead so
        // the model still gets the document's content.
        try {
          const text = (await parseOfficeAsync(tmpPath)).trim();
          if (text) {
            return {
              block: {
                type: 'document',
                source: {
                  type: 'text',
                  media_type: 'text/plain',
                  data: clipDocText(text),
                },
                title: asset.fileName,
              },
              note: 'large PDF — extracted text attached instead of the file.',
            };
          }
        } catch (extractErr) {
          console.warn(
            `[claude] ${asset.fileName}: pdf text extraction failed: ${(extractErr as Error).message}`,
          );
        }
        return { error: 'pdf too large to attach (text extraction failed)' };
      }
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
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: clipDocText(text),
          },
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
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: clipDocText(text),
          },
          title: asset.fileName,
        },
      };
    }
    if (media.kind === 'text') {
      const text = fs.readFileSync(tmpPath, 'utf-8');
      return {
        block: {
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: clipDocText(text),
          },
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

export interface GenerateWebsiteOptions {
  signal?: AbortSignal;
  /** Per-job temp directory (created by executeJob, removed in its finally
   *  block). Used to stage downloaded assets. */
  tmpDir?: string;
  anthropicClient?: Anthropic;
  /** Pass-progress reporter — becomes the job's statusMessage. */
  onProgress?: (message: string) => void | Promise<void>;
  /** Client capability: >=2 runs the rich multi-pass pipeline; absent runs
   *  legacy single-pass UNLESS the prompt is clearly from a new client. */
  pipelineVersion?: number;
}

interface PassResult {
  text: string;
  stopReason: string | null;
}

/** JSON extraction + structural validation, shared by every parse site. */
function parseFilesJson(rawText: string): WebsiteFile[] {
  let jsonText = rawText.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const parsed = JSON.parse(jsonText) as ClaudeResponse;
  if (!parsed.files || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('Claude response missing files array');
  }
  for (const file of parsed.files) {
    if (!file.path || typeof file.content !== 'string') {
      throw new Error(`Invalid file entry: ${JSON.stringify(file).slice(0, 100)}`);
    }
  }
  return parsed.files;
}

/** Patch-merge polish output over the build output (replace/add by path).
 *  Empty-content patch entries are ignored (a polish must never blank a
 *  file); the merged set must still contain index.html. */
function mergeFiles(base: WebsiteFile[], patch: WebsiteFile[]): WebsiteFile[] {
  const byPath = new Map<string, WebsiteFile>();
  for (const f of base) {
    byPath.set(f.path, f);
  }
  for (const f of patch) {
    if (f.content.trim().length === 0) {
      console.warn(`[claude] Polish returned empty ${f.path} — keeping build version`);
      continue;
    }
    byPath.set(f.path, f);
  }
  const merged = [...byPath.values()];
  if (!merged.some((f) => f.path === 'index.html')) {
    throw new Error('Merged output missing index.html');
  }
  return merged;
}

/**
 * Generate website files using the Claude API.
 *
 * Rich pipeline (new clients / curl): art-direction brief → full build →
 * art-director polish, as one growing conversation over a shared cached
 * system prefix. Legacy pipeline (old FxFiles clients, detected by their
 * embedded "=== SYSTEM CONSTRAINTS ===" block): a single improved build
 * pass sized to finish inside their 5-minute poll deadline.
 */
export async function generateWebsite(
  prompt: string,
  assets: Asset[],
  opts: GenerateWebsiteOptions = {},
): Promise<WebsiteFile[]> {
  const { signal, tmpDir, onProgress } = opts;
  const anthropicClient = opts.anthropicClient ?? client;

  const isLegacyPrompt = hasLegacyConstraintsBlock(prompt);
  const cleanPrompt = stripLegacyConstraintsBlock(prompt);
  const richPipeline =
    config.claudeMultipassEnabled &&
    (opts.pipelineVersion ?? (isLegacyPrompt ? 1 : 2)) >= 2;
  if (isLegacyPrompt) {
    console.log('[claude] Legacy client constraints block stripped from prompt');
  }

  const progress = async (message: string) => {
    try {
      await onProgress?.(message);
    } catch (err) {
      console.warn(`[claude] progress update failed: ${(err as Error).message}`);
    }
  };
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new Error('Generation was cancelled');
    }
  };

  const runPass = async (
    messages: Anthropic.MessageParam[],
    maxTokens: number,
    effort: 'low' | 'medium' | 'high',
    label: string,
    filesJson = false,
  ): Promise<PassResult> => {
    console.log(
      `[claude] Pass ${label}: model ${config.claudeModel}, max_tokens ${maxTokens}, effort ${effort}${filesJson ? ', schema-constrained' : ''}`,
    );
    let response: Anthropic.Message;
    try {
      const stream = anthropicClient.messages.stream(
        {
          model: config.claudeModel,
          max_tokens: maxTokens,
          system: SYSTEM_BLOCKS,
          thinking: { type: 'adaptive' },
          output_config: {
            effort,
            ...(filesJson
              ? { format: { type: 'json_schema', schema: FILES_JSON_SCHEMA } }
              : {}),
          },
          messages,
        } as Anthropic.MessageStreamParams,
        { signal },
      );
      response = await stream.finalMessage();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Generation was cancelled');
      }
      throw error;
    }
    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude returned no text response');
    }
    if (response.usage) {
      console.log(
        `[claude] Pass ${label}: out=${response.usage.output_tokens} cacheRead=${(response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0}`,
      );
    }
    return { text: textBlock.text.trim(), stopReason: response.stop_reason };
  };

  /** Build pass with truncation retry + JSON repair retry. */
  const runFilesPass = async (
    messages: Anthropic.MessageParam[],
    maxTokens: number,
    effort: 'low' | 'medium' | 'high',
    label: string,
  ): Promise<{ files: WebsiteFile[]; rawText: string }> => {
    // The conversation that produced the LATEST output — the repair retry
    // must build on it (including any truncation-retry turn) so the model
    // keeps every constraint it was last given.
    let attemptMessages = messages;
    let result = await runPass(attemptMessages, maxTokens, effort, label, true);
    if (result.stopReason === 'max_tokens') {
      console.warn(
        `[claude] Pass ${label} truncated at ${result.text.length} chars — retrying at reduced scope`,
      );
      throwIfAborted();
      attemptMessages = [
        ...attemptMessages,
        { role: 'assistant', content: result.text },
        { role: 'user', content: TRUNCATION_RETRY_INSTRUCTION },
      ];
      result = await runPass(
        attemptMessages,
        maxTokens,
        effort,
        `${label}-truncation-retry`,
        true,
      );
      if (result.stopReason === 'max_tokens') {
        throw new Error('Generation output exceeded the size limit twice');
      }
    }
    try {
      return { files: parseFilesJson(result.text), rawText: result.text };
    } catch (parseError) {
      console.warn(
        `[claude] Pass ${label} JSON parse failed (${result.text.length} chars), last 200: ...${result.text.slice(-200)}`,
      );
      throwIfAborted();
      const repair = await runPass(
        [
          ...attemptMessages,
          { role: 'assistant', content: result.text },
          {
            role: 'user',
            content:
              'Your previous response was not valid JSON. Please return ONLY a valid JSON object with the structure: { "files": [ { "path": "...", "content": "..." } ] }. No markdown, no explanation — just the JSON.',
          },
        ],
        maxTokens,
        effort,
        `${label}-json-repair`,
        true,
      );
      try {
        return { files: parseFilesJson(repair.text), rawText: repair.text };
      } catch {
        throw new Error(
          `Failed to parse Claude response as JSON: ${(parseError as Error).message}`,
        );
      }
    }
  };
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
      let attachedBytes = 0;
      for (const asset of assets) {
        if (signal?.aborted) {
          attached.push({ asset, result: { error: 'job aborted' } });
          continue;
        }
        let result = await attachAsset(asset, tmpDir, signal);
        if (result.block) {
          const size = blockWireBytes(result.block);
          if (attachedBytes + size > MAX_TOTAL_ATTACH_BYTES) {
            // Keep the request under the API's 32MB cap: reference-only.
            result = {
              note:
                'not attached inline (attachment budget reached) — use the ' +
                'URL above to place it in the site',
            };
            console.warn(
              `[claude] asset ${asset.fileName} over attach budget (${attachedBytes + size} > ${MAX_TOTAL_ATTACH_BYTES}) — URL-only`,
            );
          } else {
            attachedBytes += size;
          }
        }
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
  let userMessage = `Create a website with the following requirements:\n\n${cleanPrompt}`;
  if (attached.length > 0) {
    userMessage += '\n\nAvailable assets (use these URLs directly in the HTML):';
    for (const { asset, result } of attached) {
      userMessage += `\n- ${asset.fileName} (${asset.type}): ${asset.url}`;
      if (asset.content) {
        userMessage += `\n  Content description: ${asset.content}`;
      }
      if (result.block) {
        userMessage += `\n  (also attached as a ${result.block.type} block titled "${asset.fileName}")`;
        if (result.note) {
          userMessage += `\n  (${result.note})`;
        }
      } else if (result.note) {
        userMessage += `\n  (${result.note})`;
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
    `[claude] Generating: ${assets.length} assets (${attachedCount} attached as blocks), model: ${config.claudeModel}, pipeline: ${richPipeline ? 'multi-pass' : 'single-pass'}`,
  );

  // ---------------------------------------------------------------- legacy
  if (!richPipeline) {
    await progress('Generating website...');
    const { files } = await runFilesPass(
      [
        {
          role: 'user',
          content: [
            ...messageContent,
            { type: 'text', text: BUILD_PASS_INSTRUCTION },
          ],
        },
      ],
      64000,
      'medium',
      'legacy-build',
    );
    if (!files.some((f) => f.path === 'index.html')) {
      throw new Error('Claude response missing index.html');
    }
    console.log(
      `[claude] Generated ${files.length} files: ${files.map((f) => f.path).join(', ')}`,
    );
    return files;
  }

  // ------------------------------------------------------------ multi-pass
  // Pass A — art-direction brief (plain text). Degrades to no-brief on any
  // failure: the build pass carries the full design system either way.
  await progress('Designing art direction...');
  const briefRequestContent: Array<TextBlockParam | AssetContentBlock> = [
    ...messageContent,
    { type: 'text', text: BRIEF_PASS_INSTRUCTION },
  ];
  let brief: string | null = null;
  try {
    const a = await runPass(
      [{ role: 'user', content: briefRequestContent }],
      config.claudeBriefMaxTokens,
      'high',
      'brief',
    );
    if (a.stopReason === 'max_tokens') {
      console.warn(
        '[claude] Brief truncated at the token budget — raise CLAUDE_BRIEF_MAX_TOKENS (thinking counts against it)',
      );
    }
    brief = a.text.length > 0 ? a.text : null;
  } catch (err) {
    throwIfAborted();
    console.warn(
      `[claude] Brief pass failed — continuing without a brief: ${(err as Error).message}`,
    );
  }
  throwIfAborted();

  // Pass B — full build, implementing the brief.
  await progress('Building your website...');
  const buildMessages: Anthropic.MessageParam[] = brief
    ? [
        { role: 'user', content: briefRequestContent },
        { role: 'assistant', content: brief },
        { role: 'user', content: BUILD_PASS_INSTRUCTION },
      ]
    : [
        {
          role: 'user',
          content: [
            ...messageContent,
            { type: 'text', text: BUILD_PASS_INSTRUCTION },
          ],
        },
      ];
  const build = await runFilesPass(
    buildMessages,
    config.claudeBuildMaxTokens,
    'high',
    'build',
  );
  if (!build.files.some((f) => f.path === 'index.html')) {
    throw new Error('Claude response missing index.html');
  }
  throwIfAborted();

  // Pass C — art-director critique & polish. STRICTLY improve-or-keep: any
  // failure here returns the build output untouched.
  await progress('Polishing design and motion...');
  try {
    const polish = await runPass(
      [
        ...buildMessages,
        { role: 'assistant', content: build.rawText },
        { role: 'user', content: POLISH_PASS_INSTRUCTION },
      ],
      config.claudePolishMaxTokens,
      'medium',
      'polish',
      true,
    );
    if (polish.stopReason === 'max_tokens') {
      console.warn('[claude] Polish pass truncated — keeping build output');
      return build.files;
    }
    const polishFiles = parseFilesJson(polish.text);
    const merged = mergeFiles(build.files, polishFiles);
    console.log(
      `[claude] Generated ${merged.length} files (polished): ${merged.map((f) => f.path).join(', ')}`,
    );
    return merged;
  } catch (err) {
    if (signal?.aborted) {
      throw new Error('Generation was cancelled');
    }
    console.warn(
      `[claude] Polish pass failed — keeping build output: ${(err as Error).message}`,
    );
    console.log(
      `[claude] Generated ${build.files.length} files: ${build.files.map((f) => f.path).join(', ')}`,
    );
    return build.files;
  }
}

export async function askAi(
  prompt: string,
  files: { fileName: string; localPath: string }[],
  signal?: AbortSignal,
  anthropicClient: Anthropic = client
): Promise<string> {
  const attached: Array<{ fileName: string; result: AssetAttach }> = [];

  for (const file of files) {
    if (signal?.aborted) break;
    const media = detectMedia(file.fileName);
    if (media.kind === 'unknown' || media.kind === 'video') {
       attached.push({ fileName: file.fileName, result: { error: `Unsupported file type for Ask AI` }});
       continue;
    }
    
    try {
      if (media.kind === 'image') {
        const data = fs.readFileSync(file.localPath).toString('base64');
        attached.push({ fileName: file.fileName, result: { block: { type: 'image', source: { type: 'base64', media_type: media.imageMime!, data } } } });
      } else if (media.kind === 'pdf') {
        const data = fs.readFileSync(file.localPath).toString('base64');
        attached.push({ fileName: file.fileName, result: { block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: file.fileName } } });
      } else if (media.kind === 'docx') {
        const result = await mammoth.extractRawText({ path: file.localPath });
        const text = (result.value || '').trim();
        if (!text) attached.push({ fileName: file.fileName, result: { error: 'docx contained no extractable text' } });
        else attached.push({ fileName: file.fileName, result: { block: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, title: file.fileName } } });
      } else if (media.kind === 'xlsx' || media.kind === 'pptx') {
        const text = (await parseOfficeAsync(file.localPath)).trim();
        if (!text) attached.push({ fileName: file.fileName, result: { error: `${media.kind} contained no extractable text` } });
        else attached.push({ fileName: file.fileName, result: { block: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, title: file.fileName } } });
      } else if (media.kind === 'text') {
        const text = fs.readFileSync(file.localPath, 'utf-8');
        attached.push({ fileName: file.fileName, result: { block: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, title: file.fileName } } });
      }
    } catch (err) {
      attached.push({ fileName: file.fileName, result: { error: `extraction failed: ${(err as Error).message}` } });
    }
  }

  let userMessage = `You are a helpful AI assistant. The user is asking you a question about the following files:\n\n`;
  for (const { fileName, result } of attached) {
    if (result.block) {
      userMessage += `\n- Attached file: "${fileName}"`;
    } else if (result.error) {
      userMessage += `\n- Failed to attach "${fileName}": ${result.error}`;
    }
  }
  userMessage += `\n\nUser Question:\n${prompt}`;

  const messageContent: Array<TextBlockParam | AssetContentBlock> = [
    { type: 'text', text: userMessage },
  ];
  for (const { result } of attached) {
    if (result.block) {
      messageContent.push(result.block);
    }
  }

  let response: Anthropic.Message;
  try {
    const stream = anthropicClient.messages.stream(
      {
        model: config.claudeModel,
        max_tokens: 4096,
        system: "You are a helpful AI assistant. Analyze the provided files and answer the user's question clearly and concisely. If the user asks about a URL, use your web_fetch tool to read it.",
        messages: [{ role: 'user', content: messageContent }],
        // _20260209 variants (dynamic filtering, no beta header) — the
        // basic _20250305/_20250910 variants are for pre-4.6 models and the
        // default model is now claude-opus-5.
        tools: [
          { type: 'web_search_20260209', name: 'web_search' } as any,
          { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 } as any,
        ],
      },
      { signal },
    );
    response = await stream.finalMessage();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Ask AI generation was cancelled');
    }
    throw error;
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  return textBlock.text.trim();
}

