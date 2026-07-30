/**
 * Prompts for the social-post pipeline: caption writing (Claude) and the
 * 4:5 social-image brief (Gemini). Kept separate from the website prompts —
 * the two pipelines share nothing textually.
 */

/** Instagram caption hard cap (defensive clip applied server-side). */
export const LONG_CAPTION_MAX_CHARS = 2200;
/** X/Twitter hard cap — enforced INCLUDING the website URL. */
export const SHORT_CAPTION_MAX_CHARS = 280;

export const SOCIAL_CAPTION_SYSTEM_PROMPT = `You are a social media copywriter. You write captions announcing a newly launched website. Respond with a JSON object {"long": "...", "short": "..."}.
- "long": an Instagram/Facebook caption — 3 to 6 short paragraphs or lines, warm and concrete, drawn ONLY from facts in the user's brief (never invent products, prices, claims, or testimonials). Include the website URL exactly as given. End with 4-8 relevant hashtags on their own line. Maximum 2000 characters. Emojis welcome but sparing.
- "short": a Twitter/X post of AT MOST 280 characters INCLUDING every character of the website URL. One punchy hook sentence + the URL + 2-3 hashtags. Count characters carefully.
No markdown, no commentary — only the JSON object.`;

export function buildCaptionUserMessage(prompt: string, websiteUrl: string): string {
  return (
    `Website brief (the user's own words):\n${prompt}\n\n` +
    `Website URL (must appear in BOTH captions exactly as written): ${websiteUrl}`
  );
}

export function buildShortCaptionRetryInstruction(
  shortCaption: string,
  websiteUrl: string,
): string {
  const problems: string[] = [];
  if (shortCaption.length > SHORT_CAPTION_MAX_CHARS) {
    problems.push(`it is ${shortCaption.length} characters (max ${SHORT_CAPTION_MAX_CHARS})`);
  }
  if (!shortCaption.includes(websiteUrl)) {
    problems.push('it does not contain the website URL');
  }
  return (
    `Your "short" caption is invalid: ${problems.join(' and ')}. ` +
    `Rewrite the JSON object with a corrected "short" of at most ${SHORT_CAPTION_MAX_CHARS} characters ` +
    `INCLUDING the URL ${websiteUrl}, keeping "long" unchanged. Return only the JSON object.`
  );
}

/** Direct art-direction template — deliberately NO extra Claude "brief" pass:
 *  the reference images carry the brand's real visual identity and this
 *  template supplies the ad-craft, letting captions and image generation run
 *  in parallel. */
export function buildImagePrompt(userPrompt: string): string {
  const truncated =
    userPrompt.length > 2000 ? `${userPrompt.slice(0, 2000)}…` : userPrompt;
  return (
    'Create a single scroll-stopping social media image (4:5 portrait) announcing the launch of a website. ' +
    'Use the attached reference images as the visual source of truth for the brand: reuse their subjects, products, palette, and mood — do not contradict them. ' +
    `The website is about: ${truncated}\n` +
    'Art direction: premium, editorial promotional-poster feel; one clear focal subject; generous negative space toward the top or bottom for legibility; cohesive color palette derived from the reference images; soft studio lighting; no watermarks, no borders, no fake UI screenshots, and no more than 4 words of stylized text (or none at all).'
  );
}
