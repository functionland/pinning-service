import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/index.js', () => ({
  config: {
    claudeApiKey: 'test-only-key',
    claudeModel: 'claude-opus-5',
    claudeSocialModel: '',
  },
}));

import {
  generateSocialCaptions,
  fixShortCaption,
} from '../src/services/socialCaptions.js';

const URL = 'https://fxfiles.top/w/k51abc';

function message(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as Anthropic.Message;
}

function fakeClient(responses: Array<Anthropic.Message | Error>) {
  const queue = [...responses];
  const stream = vi.fn(() => ({
    finalMessage: vi.fn(async () => {
      const response = queue.shift();
      if (!response) throw new Error('No mocked Claude response left');
      if (response instanceof Error) throw response;
      return response;
    }),
  }));
  return { client: { messages: { stream } } as unknown as Anthropic, stream };
}

const GOOD = { long: `Great long caption. ${URL}`, short: `Check it out ${URL} #launch` };

describe('generateSocialCaptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns validated captions and requests the JSON schema', async () => {
    const { client, stream } = fakeClient([message(JSON.stringify(GOOD))]);
    const captions = await generateSocialCaptions('A bakery site', URL, {
      anthropicClient: client,
    });
    expect(captions).toEqual(GOOD);
    expect(stream).toHaveBeenCalledTimes(1);
    const req = stream.mock.calls[0][0] as any;
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.output_config.effort).toBe('low');
    expect(req.max_tokens).toBe(4000);
    expect(req.messages[0].content).toContain(URL);
  });

  it('retries once when short exceeds 280 chars, then accepts the fix', async () => {
    const tooLong = { ...GOOD, short: `${'x'.repeat(300)} ${URL}` };
    const { client, stream } = fakeClient([
      message(JSON.stringify(tooLong)),
      message(JSON.stringify(GOOD)),
    ]);
    const captions = await generateSocialCaptions('p', URL, { anthropicClient: client });
    expect(stream).toHaveBeenCalledTimes(2);
    expect(captions.short).toBe(GOOD.short);
    const retryReq = stream.mock.calls[1][0] as any;
    expect(retryReq.messages).toHaveLength(3); // user, assistant, corrective user
  });

  it('deterministically truncates when the retry is still invalid', async () => {
    const bad = { ...GOOD, short: `${'y'.repeat(400)} ${URL}` };
    const { client } = fakeClient([
      message(JSON.stringify(bad)),
      message(JSON.stringify(bad)),
    ]);
    const captions = await generateSocialCaptions('p', URL, { anthropicClient: client });
    expect(captions.short.length).toBeLessThanOrEqual(280);
    expect(captions.short).toContain(URL);
  });

  it('appends the URL when missing and falls back deterministically on retry failure', async () => {
    const noUrl = { ...GOOD, short: 'no url here #oops' };
    const { client } = fakeClient([
      message(JSON.stringify(noUrl)),
      new Error('api down'),
    ]);
    const captions = await generateSocialCaptions('p', URL, { anthropicClient: client });
    expect(captions.short).toContain(URL);
    expect(captions.short.length).toBeLessThanOrEqual(280);
  });

  it('clips long captions at 2200 chars', async () => {
    const huge = { long: `${'z'.repeat(3000)} ${URL}`, short: GOOD.short };
    const { client } = fakeClient([message(JSON.stringify(huge))]);
    const captions = await generateSocialCaptions('p', URL, { anthropicClient: client });
    expect(captions.long.length).toBeLessThanOrEqual(2200);
  });
});

describe('fixShortCaption', () => {
  it('keeps a valid caption unchanged', () => {
    expect(fixShortCaption(`hi ${URL}`, URL)).toBe(`hi ${URL}`);
  });
  it('appends the URL when missing', () => {
    expect(fixShortCaption('hi there', URL)).toBe(`hi there ${URL}`);
  });
  it('never truncates the URL when trimming', () => {
    const fixed = fixShortCaption(`${'a'.repeat(500)} ${URL}`, URL);
    expect(fixed.length).toBeLessThanOrEqual(280);
    expect(fixed).toContain(URL);
  });
  it('handles an empty caption', () => {
    expect(fixShortCaption('', URL)).toBe(URL);
  });
});
