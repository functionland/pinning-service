/**
 * Prompts for the social-post pipeline: caption writing (Claude) and the
 * 4:5 social-image brief (Gemini).
 *
 * The single most important thing these prompts do is RE-FRAME the input.
 * The brief they receive was originally written by the user to commission a
 * WEBSITE. Passed through naively, a model reasonably reads "a landing page
 * with a hero section for my bakery" as instructions and returns a picture
 * of a web page, or copy announcing that a website now exists. Both prompts
 * therefore state explicitly that the brief is BACKGROUND ABOUT THE BUSINESS
 * and never a description of the artifact to produce.
 */

/** Instagram caption hard cap (defensive clip applied server-side). */
export const LONG_CAPTION_MAX_CHARS = 2200;
/** X/Twitter hard cap — enforced INCLUDING the website URL. */
export const SHORT_CAPTION_MAX_CHARS = 280;

export const SOCIAL_CAPTION_SYSTEM_PROMPT = `You are a social media copywriter for a brand. You write posts that sell the brand itself — what it makes, who it's for, why it's worth someone's attention — and use its website as the call to action. You are NOT announcing that a website exists; nobody follows a brand to hear about its web page.

Respond with a JSON object {"long": "...", "short": "..."} and nothing else.

"long" — an Instagram/Facebook caption:
- Open with a hook that earns the tap on "more": a vivid concrete detail, a question, or a confident claim taken from the brief. Never open with the brand name, "Introducing", "We are excited to", or "Check out".
- Then 2-4 short lines of real substance — specific things from the brief, not adjectives about them.
- Close with a clear call to action and the website URL exactly as given.
- Last line: 4-8 relevant hashtags, mixing broad and niche.
- Max 2000 characters. Emoji are fine where they carry warmth; a handful at most, never as bullet points.

"short" — an X/Twitter post:
- AT MOST 280 characters INCLUDING every character of the URL. Count carefully.
- One punchy line, then the URL, then 2-3 hashtags.

Rules for both:
- Use ONLY facts present in the brief. Never invent products, prices, ingredients, awards, testimonials, opening hours, or locations.
- No corporate filler ("we are pleased to announce", "elevate your experience"), no hype adjectives ("game-changing", "revolutionary", "unparalleled"), no engagement-bait ("double tap if...").
- Write the way a brand people actually like posts: specific, warm, a little bit human.`;

export function buildCaptionUserMessage(prompt: string, websiteUrl: string): string {
  return (
    'Brand brief. NOTE: this text was originally written to commission a ' +
    'website, so treat it purely as background about the business — do not ' +
    'write about the website itself, its pages, or its design.\n\n' +
    `${prompt}\n\n` +
    `Website URL, to use as the call to action in both captions, copied exactly as written: ${websiteUrl}`
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

/**
 * Direct art-direction template — deliberately NO extra Claude "brief" pass:
 * the reference images carry the brand's real visual identity and this
 * template supplies the ad-craft, which lets captions and image generation
 * run in parallel.
 */
export function buildImagePrompt(userPrompt: string): string {
  const truncated =
    userPrompt.length > 2000 ? `${userPrompt.slice(0, 2000)}…` : userPrompt;
  return (
    'Create ONE social media post image: a single 4:5 portrait graphic made to stop the scroll in an Instagram or Facebook feed.\n\n' +
    'It is NOT a website, landing page, screenshot, app interface, browser window, device mockup, or poster of a web page. Never draw navigation bars, menus, buttons, cursors, address bars, scrollbars, or any user-interface chrome.\n\n' +
    `What the brand is about:\n${truncated}\n\n` +
    'That description was originally written to commission a website, so read it ONLY as background about the business, its products and its personality — never as instructions about what to depict or lay out.\n\n' +
    'Use the attached reference photographs as the visual source of truth for this brand: reuse their actual subjects, products, materials, colours and mood. Do not invent products that are not shown in them.\n\n' +
    'Art direction: one bold focal subject, framed close and lit beautifully, with the finish of a brand\'s own campaign photography — rich, tactile, intentional. Build a cohesive palette from the reference images. Leave generous, deliberate negative space in the upper or lower third so a headline could sit there comfortably. Composition should read instantly at thumbnail size.\n\n' +
    'Avoid: watermarks, invented logos or brand marks, borders and frames, collages or split panels, stock-photo blandness, and text — at most four words of stylised type, and none at all is usually better.'
  );
}
