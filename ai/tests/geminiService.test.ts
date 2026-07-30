import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/index.js', () => ({
  config: {
    geminiApiKey: 'test-key',
    geminiImageModel: 'gemini-3.1-flash-image',
    geminiImageSize: '1K',
  },
}));

import { generateSocialImage } from '../src/services/geminiService.js';

const PNG_BASE64 = Buffer.from('fake-image-bytes').toString('base64');

function imageResponse() {
  return {
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'Here is your image' },
            { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
          ],
        },
      },
    ],
  };
}

function fakeGenai(responses: Array<object | Error>) {
  const queue = [...responses];
  const generateContent = vi.fn(async () => {
    const r = queue.shift();
    if (!r) throw new Error('No mocked Gemini response left');
    if (r instanceof Error) throw r;
    return r;
  });
  return { client: { models: { generateContent } } as any, generateContent };
}

describe('generateSocialImage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends refs + prompt with 4:5 image config and extracts the image bytes', async () => {
    const { client, generateContent } = fakeGenai([imageResponse()]);
    const refs = [
      { base64: 'AAAA', mimeType: 'image/jpeg' },
      { base64: 'BBBB', mimeType: 'image/jpeg' },
    ];
    const buf = await generateSocialImage('make it pop', refs, { genaiClient: client });
    expect(buf.toString()).toBe('fake-image-bytes');

    const req = generateContent.mock.calls[0][0] as any;
    expect(req.model).toBe('gemini-3.1-flash-image');
    expect(req.config.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(req.config.imageConfig).toEqual({ aspectRatio: '4:5', imageSize: '1K' });
    const parts = req.contents[0].parts;
    expect(parts).toHaveLength(3); // 2 refs + 1 text
    expect(parts[0].inlineData.data).toBe('AAAA');
    expect(parts[2].text).toBe('make it pop');
  });

  it('retries once on a 500-class error', async () => {
    const { client, generateContent } = fakeGenai([
      new Error('got status: 500 Internal Server Error'),
      imageResponse(),
    ]);
    const buf = await generateSocialImage('p', [], { genaiClient: client });
    expect(buf.length).toBeGreaterThan(0);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const { client, generateContent } = fakeGenai([
      new Error('got status: 400 invalid argument'),
    ]);
    await expect(generateSocialImage('p', [], { genaiClient: client })).rejects.toThrow('400');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('maps a safety block (no image part) to a friendly error', async () => {
    const { client } = fakeGenai([
      { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'no' }] } }] },
    ]);
    await expect(generateSocialImage('p', [], { genaiClient: client })).rejects.toThrow(
      /declined this request/
    );
  });
});
