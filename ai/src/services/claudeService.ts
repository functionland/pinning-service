/**
 * Claude Service
 *
 * Uses Anthropic SDK to generate website files via Claude API.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';

export interface WebsiteFile {
  path: string;
  content: string;
}

interface ClaudeResponse {
  files: WebsiteFile[];
}

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

/**
 * Generate website files using Claude API
 */
export async function generateWebsite(
  prompt: string,
  assets: Array<{ fileName: string; type: string; url: string; content?: string }>,
  signal?: AbortSignal
): Promise<WebsiteFile[]> {
  // Build user message
  let userMessage = `Create a website with the following requirements:\n\n${prompt}`;

  if (assets.length > 0) {
    userMessage += '\n\nAvailable assets (use these URLs directly in the HTML):';
    for (const asset of assets) {
      userMessage += `\n- ${asset.fileName} (${asset.type}): ${asset.url}`;
      if (asset.content) {
        userMessage += `\n  Content description: ${asset.content}`;
      }
    }
  }

  console.log(`[claude] Generating website with ${assets.length} assets, model: ${config.claudeModel}`);

  let response: Anthropic.Message;
  try {
    const stream = client.messages.stream(
      {
        model: config.claudeModel,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal }
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
    // Retry once — ask Claude to fix its output
    console.warn(`[claude] Failed to parse response (${rawText.length} chars), last 200 chars: ...${rawText.slice(-200)}`);
    console.warn('[claude] Retrying with correction prompt');
    try {
      const retryStream = client.messages.stream(
        {
          model: config.claudeModel,
          max_tokens: 64000,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: rawText },
            {
              role: 'user',
              content:
                'Your previous response was not valid JSON. Please return ONLY a valid JSON object with the structure: { "files": [ { "path": "...", "content": "..." } ] }. No markdown, no explanation — just the JSON.',
            },
          ],
        },
        { signal }
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
