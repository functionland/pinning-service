/**
 * Live smoke test for the social-post pipeline's external calls.
 *
 * Run: npm run test:live-social   (requires real GEMINI_API_KEY and
 * CLAUDE_API_KEY in the environment / .env)
 *
 * Pins down the exact @google/genai request/config shape accepted by the
 * configured GEMINI_IMAGE_MODEL (aspectRatio 4:5, imageSize) BEFORE rollout,
 * and exercises the caption call end-to-end. Writes the generated image to
 * ./social-smoke.jpg for eyeball verification (should be 1080×1350 after the
 * sharp normalize).
 */

import fs from 'fs';
import sharp from 'sharp';
import { generateSocialImage } from '../services/geminiService.js';
import { generateSocialCaptions } from '../services/socialCaptions.js';
import { buildImagePrompt } from '../prompts/socialPrompts.js';
import { config } from '../config/index.js';

async function main() {
  console.log(`[smoke] model=${config.geminiImageModel} size=${config.geminiImageSize}`);

  const prompt =
    'A cozy neighborhood bakery called Sunrise Loaf — sourdough, croissants, ' +
    'and seasonal fruit tarts, baked fresh every morning.';
  const websiteUrl = 'https://fxfiles.top/w/example';

  console.log('[smoke] Generating captions (Claude)...');
  const captions = await generateSocialCaptions(prompt, websiteUrl);
  console.log(`[smoke] long (${captions.long.length} chars):\n${captions.long}\n`);
  console.log(`[smoke] short (${captions.short.length} chars): ${captions.short}`);
  if (captions.short.length > 280 || !captions.short.includes(websiteUrl)) {
    throw new Error('short caption failed validation');
  }

  console.log('[smoke] Generating image (Gemini, no reference images)...');
  const raw = await generateSocialImage(buildImagePrompt(prompt), []);
  const meta = await sharp(raw).metadata();
  console.log(`[smoke] raw image: ${meta.width}x${meta.height} ${meta.format}`);

  const jpeg = await sharp(raw)
    .resize(1080, 1350, { fit: 'cover' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  fs.writeFileSync('social-smoke.jpg', jpeg);
  const outMeta = await sharp(jpeg).metadata();
  console.log(
    `[smoke] normalized: ${outMeta.width}x${outMeta.height} — written to social-smoke.jpg`,
  );
  if (outMeta.width !== 1080 || outMeta.height !== 1350) {
    throw new Error('normalized image is not 1080x1350');
  }
  console.log('[smoke] PASS');
}

main().catch((err) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
