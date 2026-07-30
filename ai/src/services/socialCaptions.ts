/**
 * Social caption generation (Claude).
 *
 * One JSON-schema-constrained call producing {long, short}. The short caption
 * is validated server-side (≤280 chars INCLUDING the website URL): one
 * corrective retry turn, then a deterministic fix that always preserves the
 * URL. Model: CLAUDE_SOCIAL_MODEL when set (cost lever), else CLAUDE_MODEL.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import {
  SOCIAL_CAPTION_SYSTEM_PROMPT,
  buildCaptionUserMessage,
  buildShortCaptionRetryInstruction,
  LONG_CAPTION_MAX_CHARS,
  SHORT_CAPTION_MAX_CHARS,
} from '../prompts/socialPrompts.js';

export interface SocialCaptions {
  long: string;
  short: string;
}

export interface GenerateSocialCaptionsOptions {
  signal?: AbortSignal;
  /** Injectable seam for tests. */
  anthropicClient?: Anthropic;
}

const CAPTIONS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    long: { type: 'string' },
    short: { type: 'string' },
  },
  required: ['long', 'short'],
  additionalProperties: false,
};

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: config.claudeApiKey });
  }
  return cachedClient;
}

function parseCaptions(rawText: string): SocialCaptions {
  let jsonText = rawText.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const parsed = JSON.parse(jsonText) as Partial<SocialCaptions>;
  if (typeof parsed.long !== 'string' || typeof parsed.short !== 'string') {
    throw new Error('Caption response missing long/short strings');
  }
  return { long: parsed.long.trim(), short: parsed.short.trim() };
}

function shortIsValid(short: string, websiteUrl: string): boolean {
  return short.length <= SHORT_CAPTION_MAX_CHARS && short.includes(websiteUrl);
}

/** Deterministic last-resort fix: guarantee URL presence, then trim the text
 *  portion so total length ≤ 280 while the URL survives intact. */
export function fixShortCaption(short: string, websiteUrl: string): string {
  let text = short;
  if (!text.includes(websiteUrl)) {
    text = text.trim();
    text = text.length > 0 ? `${text} ${websiteUrl}` : websiteUrl;
  }
  if (text.length <= SHORT_CAPTION_MAX_CHARS) {
    return text;
  }
  // Too long: rebuild as trimmed-text + URL. The URL is never truncated.
  const withoutUrl = text.replace(websiteUrl, '').replace(/\s+/g, ' ').trim();
  const budget = SHORT_CAPTION_MAX_CHARS - websiteUrl.length - 1;
  if (budget <= 0) {
    // A URL that alone exceeds the cap is NEVER truncated — X shortens
    // links to a fixed t.co length at publish time, so the full URL is the
    // least-wrong output.
    return websiteUrl;
  }
  const clipped =
    withoutUrl.length > budget ? `${withoutUrl.slice(0, budget - 1)}…` : withoutUrl;
  return `${clipped} ${websiteUrl}`.trim();
}

export async function generateSocialCaptions(
  prompt: string,
  websiteUrl: string,
  opts: GenerateSocialCaptionsOptions = {},
): Promise<SocialCaptions> {
  const client = opts.anthropicClient ?? getClient();
  const model = config.claudeSocialModel || config.claudeModel;

  const runPass = async (messages: Anthropic.MessageParam[]): Promise<string> => {
    let response: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 4000,
          system: SOCIAL_CAPTION_SYSTEM_PROMPT,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: CAPTIONS_JSON_SCHEMA },
          },
          messages,
        } as Anthropic.MessageStreamParams,
        { signal: opts.signal },
      );
      response = await stream.finalMessage();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Social post generation was cancelled');
      }
      throw error;
    }
    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude returned no caption text');
    }
    if (response.usage) {
      console.log(`[social] Captions: out=${response.usage.output_tokens}`);
    }
    return textBlock.text.trim();
  };

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildCaptionUserMessage(prompt, websiteUrl) },
  ];
  const firstText = await runPass(messages);
  let captions = parseCaptions(firstText);

  if (!shortIsValid(captions.short, websiteUrl)) {
    console.warn(
      `[social] Short caption invalid (${captions.short.length} chars, url=${captions.short.includes(websiteUrl)}) — corrective retry`,
    );
    if (opts.signal?.aborted) {
      throw new Error('Social post generation was cancelled');
    }
    try {
      const retryText = await runPass([
        ...messages,
        { role: 'assistant', content: firstText },
        {
          role: 'user',
          content: buildShortCaptionRetryInstruction(captions.short, websiteUrl),
        },
      ]);
      const retried = parseCaptions(retryText);
      captions = shortIsValid(retried.short, websiteUrl)
        ? retried
        : { ...retried, short: fixShortCaption(retried.short, websiteUrl) };
    } catch (retryErr) {
      console.warn(
        `[social] Caption retry failed (${(retryErr as Error).message}) — deterministic fix`,
      );
      captions = { ...captions, short: fixShortCaption(captions.short, websiteUrl) };
    }
  }

  if (captions.long.length > LONG_CAPTION_MAX_CHARS) {
    captions = { ...captions, long: `${captions.long.slice(0, LONG_CAPTION_MAX_CHARS - 1)}…` };
  }
  return captions;
}
