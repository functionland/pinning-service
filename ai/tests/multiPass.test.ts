import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/index.js', () => ({
  config: {
    claudeApiKey: 'test-only-key',
    claudeModel: 'claude-opus-4-6',
    claudeDesignSkillEnabled: true,
    claudeMultipassEnabled: true,
    claudeBriefMaxTokens: 4000,
    claudeBuildMaxTokens: 96000,
    claudePolishMaxTokens: 64000,
  },
}));

import { generateWebsite } from '../src/services/claudeService.js';
import {
  LEGACY_CONSTRAINTS_END,
  LEGACY_CONSTRAINTS_START,
} from '../src/prompts/promptCompat.js';

function message(
  text: string,
  stopReason: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stopReason,
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

  return {
    client: { messages: { stream } } as unknown as Anthropic,
    stream,
  };
}

const BRIEF = 'CONCEPT: quiet editorial with terracotta accent.';
const BUILD_FILES = {
  files: [
    { path: 'index.html', content: '<!doctype html><h1>Built</h1>' },
    { path: 'styles.css', content: ':root{--ink:#111}' },
    { path: 'app.js', content: 'console.log(1)' },
  ],
};
const POLISH_FILES = {
  files: [{ path: 'styles.css', content: ':root{--ink:#000;--accent:#c96}' }],
};

describe('multi-pass website generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('runs brief → build → polish with per-pass budgets and merges the polish patch', async () => {
    const progress: string[] = [];
    const { client, stream } = fakeClient([
      message(BRIEF),
      message(JSON.stringify(BUILD_FILES)),
      message(JSON.stringify(POLISH_FILES)),
    ]);

    const files = await generateWebsite('Build a studio site', [], {
      anthropicClient: client,
      pipelineVersion: 2,
      onProgress: (m) => {
        progress.push(m);
      },
    });

    expect(stream).toHaveBeenCalledTimes(3);
    expect(progress).toEqual([
      'Designing art direction...',
      'Building your website...',
      'Polishing design and motion...',
    ]);

    const [briefReq, buildReq, polishReq] = stream.mock.calls.map(
      (c) => c[0] as any,
    );

    expect(briefReq.max_tokens).toBe(4000);
    // Brief is free text — no schema constraint.
    expect(briefReq.output_config).toEqual({ effort: 'high' });
    expect(briefReq.thinking).toEqual({ type: 'adaptive' });
    expect(briefReq.messages).toHaveLength(1);
    expect(briefReq.messages[0].content.at(-1).text).toContain(
      'ART DIRECTION BRIEF',
    );

    expect(buildReq.max_tokens).toBe(96000);
    expect(buildReq.output_config.effort).toBe('high');
    expect(buildReq.output_config.format.type).toBe('json_schema');
    // Growing conversation: brief request → assistant brief → build ask.
    expect(buildReq.messages).toHaveLength(3);
    expect(buildReq.messages[1]).toEqual({ role: 'assistant', content: BRIEF });
    expect(buildReq.messages[2].content).toContain('build the COMPLETE site');
    // Same system prefix on every pass (cache reuse).
    expect(buildReq.system).toEqual(briefReq.system);

    expect(polishReq.max_tokens).toBe(64000);
    expect(polishReq.output_config.effort).toBe('medium');
    expect(polishReq.output_config.format.type).toBe('json_schema');
    // Build raw JSON echoed as an assistant turn before the polish ask.
    expect(polishReq.messages).toHaveLength(5);
    expect(polishReq.messages[3].role).toBe('assistant');
    expect(polishReq.messages[3].content).toContain('Built');
    expect(polishReq.messages[4].content).toContain('demanding art director');

    // Polish patch replaced styles.css, kept the other files.
    expect(files).toHaveLength(3);
    expect(files.find((f) => f.path === 'styles.css')!.content).toContain(
      '--accent',
    );
    expect(files.find((f) => f.path === 'index.html')!.content).toContain(
      'Built',
    );
  });

  it('degrades to a no-brief build when the brief pass fails', async () => {
    const { client, stream } = fakeClient([
      new Error('overloaded'),
      message(JSON.stringify(BUILD_FILES)),
      message(JSON.stringify(POLISH_FILES)),
    ]);

    const files = await generateWebsite('Build a site', [], {
      anthropicClient: client,
      pipelineVersion: 2,
    });

    expect(stream).toHaveBeenCalledTimes(3);
    const buildReq = stream.mock.calls[1][0] as any;
    // No assistant brief turn — single user turn carrying the build ask.
    expect(buildReq.messages).toHaveLength(1);
    expect(files.some((f) => f.path === 'index.html')).toBe(true);
  });

  it('returns the build output untouched when the polish pass returns garbage', async () => {
    const { client, stream } = fakeClient([
      message(BRIEF),
      message(JSON.stringify(BUILD_FILES)),
      message('not json at all'),
    ]);

    const files = await generateWebsite('Build a site', [], {
      anthropicClient: client,
      pipelineVersion: 2,
    });

    expect(stream).toHaveBeenCalledTimes(3);
    expect(files).toEqual(BUILD_FILES.files);
  });

  it('returns the build output when the polish pass truncates', async () => {
    const { client } = fakeClient([
      message(BRIEF),
      message(JSON.stringify(BUILD_FILES)),
      message('{"files":[{"path":"sty', 'max_tokens'),
    ]);

    const files = await generateWebsite('Build a site', [], {
      anthropicClient: client,
      pipelineVersion: 2,
    });
    expect(files).toEqual(BUILD_FILES.files);
  });

  it('retries a truncated build once with the reduced-scope instruction, then fails', async () => {
    const { client, stream } = fakeClient([
      message(BRIEF),
      message('{"files":[{"path":"index.html","content":"<h1>partial', 'max_tokens'),
      message(JSON.stringify(BUILD_FILES)),
      message(JSON.stringify(POLISH_FILES)),
    ]);

    const files = await generateWebsite('Build a site', [], {
      anthropicClient: client,
      pipelineVersion: 2,
    });

    expect(stream).toHaveBeenCalledTimes(4);
    const retryReq = stream.mock.calls[2][0] as any;
    expect(retryReq.messages.at(-1).content).toContain('cut off');
    expect(retryReq.messages.at(-2).role).toBe('assistant');
    expect(files).toHaveLength(3);

    // Twice-truncated build fails the job.
    const twice = fakeClient([
      message(BRIEF),
      message('{"partial', 'max_tokens'),
      message('{"partial again', 'max_tokens'),
    ]);
    await expect(
      generateWebsite('Build a site', [], {
        anthropicClient: twice.client,
        pipelineVersion: 2,
      }),
    ).rejects.toThrow('size limit twice');
  });

  it('rejects a polish merge that drops index.html by keeping the build files', async () => {
    const { client } = fakeClient([
      message(BRIEF),
      message(JSON.stringify(BUILD_FILES)),
      // Polish "renames" the entry point — merge keeps index.html anyway
      // (patch adds home.html; index.html persists from the build set).
      message(
        JSON.stringify({
          files: [{ path: 'home.html', content: '<!doctype html>' }],
        }),
      ),
    ]);

    const files = await generateWebsite('Build a site', [], {
      anthropicClient: client,
      pipelineVersion: 2,
    });
    expect(files.some((f) => f.path === 'index.html')).toBe(true);
  });

  it('routes legacy prompts (embedded SYSTEM CONSTRAINTS block) to single-pass and strips the block', async () => {
    const legacyPrompt = [
      `${LEGACY_CONSTRAINTS_START}`,
      'Output budget: Your TOTAL JSON response must be UNDER 40KB.',
      `${LEGACY_CONSTRAINTS_END}`,
      '',
      'User request:',
      'A bakery site.',
    ].join('\n');
    const { client, stream } = fakeClient([
      message(
        JSON.stringify({
          files: [{ path: 'index.html', content: '<!doctype html>' }],
        }),
      ),
    ]);

    const files = await generateWebsite(legacyPrompt, [], {
      anthropicClient: client,
    });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(files).toHaveLength(1);
    const request = stream.mock.calls[0][0] as any;
    const text = request.messages[0].content[0].text as string;
    expect(text).not.toContain('SYSTEM CONSTRAINTS');
    expect(text).not.toContain('UNDER 40KB');
    expect(text).toContain('A bakery site.');
  });

  it('an explicit pipeline_version 2 wins over a legacy-looking prompt', async () => {
    const legacyPrompt = `${LEGACY_CONSTRAINTS_START}\nbudget\n${LEGACY_CONSTRAINTS_END}\nA site.`;
    const { client, stream } = fakeClient([
      message(BRIEF),
      message(JSON.stringify(BUILD_FILES)),
      message(JSON.stringify(POLISH_FILES)),
    ]);

    await generateWebsite(legacyPrompt, [], {
      anthropicClient: client,
      pipelineVersion: 2,
    });
    expect(stream).toHaveBeenCalledTimes(3);
  });
});
