/**
 * Gemini image generation for social posts.
 *
 * Calls the Gemini API (@google/genai) with the user's reference images as
 * inline parts plus an art-direction prompt, requesting a 4:5 image. Model is
 * env-configurable (GEMINI_IMAGE_MODEL); the request/config shape below is
 * pinned by src/scripts/liveSocialSmoke.ts — run it against a real key before
 * changing models.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config/index.js';

export interface ReferenceImage {
  /** JPEG bytes, already downscaled by the caller. */
  base64: string;
  mimeType: string;
}

export interface GenerateSocialImageOptions {
  signal?: AbortSignal;
  /** Injectable seam for tests (mirrors claudeService's anthropicClient). */
  genaiClient?: GoogleGenAI;
}

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!cachedClient) {
    if (!config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    cachedClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return cachedClient;
}

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b(429|500|502|503|504)\b/.test(msg) ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed')
  );
}

/**
 * Generate one social image; returns raw image bytes (whatever encoding the
 * model emitted — the caller normalizes with sharp).
 */
export async function generateSocialImage(
  imagePrompt: string,
  referenceImages: ReferenceImage[],
  opts: GenerateSocialImageOptions = {},
): Promise<Buffer> {
  const client = opts.genaiClient ?? getClient();

  const parts: Array<Record<string, unknown>> = [
    ...referenceImages.map((r) => ({
      inlineData: { mimeType: r.mimeType, data: r.base64 },
    })),
    { text: imagePrompt },
  ];

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.signal?.aborted) {
      throw new Error('Social post generation was cancelled');
    }
    try {
      const response = await client.models.generateContent({
        model: config.geminiImageModel,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: '4:5',
            imageSize: config.geminiImageSize,
          },
          abortSignal: opts.signal,
        },
      } as Parameters<GoogleGenAI['models']['generateContent']>[0]);

      const candidate = response.candidates?.[0];
      const imagePart = candidate?.content?.parts?.find(
        (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
      );
      if (!imagePart?.inlineData?.data) {
        // Safety blocks surface as a candidate with no image part (or a
        // block reason) — map to a user-readable, refundable failure.
        const reason =
          candidate?.finishReason ??
          (response as { promptFeedback?: { blockReason?: string } }).promptFeedback
            ?.blockReason ??
          'no image returned';
        throw new Error(
          `The image generator declined this request (${reason}). Try rewording the prompt.`,
        );
      }
      return Buffer.from(imagePart.inlineData.data, 'base64');
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (opts.signal?.aborted || !isRetryable(lastErr) || attempt >= 1) {
        break;
      }
      console.warn(`[social] Gemini retry after: ${lastErr.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr ?? new Error('Gemini image generation failed');
}
