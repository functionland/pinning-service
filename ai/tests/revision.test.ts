import os from 'os';

import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/index.js', () => ({
  config: {
    claudeApiKey: 'test-only-key',
    claudeModel: 'claude-opus-5',
    claudeDesignSkillEnabled: true,
    claudeMultipassEnabled: true,
    claudeBriefMaxTokens: 4000,
    claudeBuildMaxTokens: 96000,
    claudePolishMaxTokens: 64000,
    claudeRevisionMaxTokens: 64000,
  },
}));

import { applyRevisionPatch, reviseWebsite } from '../src/services/claudeService.js';
import { describeSettingsDelta, isNoOpRevision } from '../src/services/revisionPlan.js';

function message(
  text: string,
  stopReason: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
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
  return { client: { messages: { stream } } as unknown as Anthropic, stream };
}

/** The user-turn text of the Nth call. */
function userText(stream: ReturnType<typeof fakeClient>['stream'], call = 0): string {
  const params = stream.mock.calls[call][0] as Anthropic.MessageStreamParams;
  const content = params.messages[0].content as Array<{ type: string; text?: string }>;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

const BASE_FILES = [
  {
    path: 'index.html',
    content: '<!doctype html>\n<h1 class="hero">Aurora Studio</h1>\n<p>We design.</p>',
  },
  { path: 'styles.css', content: ':root{--ink:#111;--accent:#c96}\n.hero{font-size:4rem}' },
  { path: 'about.html', content: '<!doctype html>\n<h1>About</h1>' },
];

const PROMPT = [
  '=== PALETTE PREFERENCE (auto-added) ===',
  'Use a warm palette.',
  '=== END PALETTE PREFERENCE ===',
  '',
  'User request:',
  'Website Name: Aurora Studio',
  'Category: Corporation',
  'Styles: Editorial',
  'Palette: Warm',
  '',
  'A studio site for Aurora.',
].join('\n');

describe('isNoOpRevision', () => {
  const assets = [
    { fileName: 'a.png', url: 'https://gw/ipfs/cid-a' },
    { fileName: 'b.png', url: 'https://gw/ipfs/cid-b' },
  ];

  it('is a no-op when nothing was asked for and nothing changed', () => {
    expect(
      isNoOpRevision({
        basePrompt: PROMPT,
        baseAssets: assets,
        newPrompt: PROMPT,
        newAssets: assets,
        revisionRequest: '',
      }),
    ).toBe(true);
  });

  it('treats whitespace-only and null change requests as empty', () => {
    for (const revisionRequest of ['   \n  ', null, undefined]) {
      expect(
        isNoOpRevision({
          basePrompt: PROMPT,
          baseAssets: assets,
          newPrompt: PROMPT,
          newAssets: assets,
          revisionRequest,
        }),
      ).toBe(true);
    }
  });

  it('ignores CRLF and trailing-whitespace differences in the prompt', () => {
    expect(
      isNoOpRevision({
        basePrompt: PROMPT,
        baseAssets: assets,
        newPrompt: `${PROMPT.replace(/\n/g, '\r\n')}\n\n`,
        newAssets: assets,
        revisionRequest: '',
      }),
    ).toBe(true);
  });

  it('ignores asset ORDER', () => {
    expect(
      isNoOpRevision({
        basePrompt: PROMPT,
        baseAssets: assets,
        newPrompt: PROMPT,
        newAssets: [...assets].reverse(),
        revisionRequest: '',
      }),
    ).toBe(true);
  });

  it('is not a no-op when the user typed a change request', () => {
    expect(
      isNoOpRevision({
        basePrompt: PROMPT,
        baseAssets: assets,
        newPrompt: PROMPT,
        newAssets: assets,
        revisionRequest: 'make the heading blue',
      }),
    ).toBe(false);
  });

  it('is not a no-op when any settings changed, including hidden blocks', () => {
    expect(
      isNoOpRevision({
        basePrompt: PROMPT,
        baseAssets: assets,
        newPrompt: PROMPT.replace('Palette: Warm', 'Palette: Cold'),
        newAssets: assets,
        revisionRequest: '',
      }),
    ).toBe(false);

    expect(
      isNoOpRevision({
        basePrompt: PROMPT,
        baseAssets: assets,
        newPrompt: `${PROMPT}\n\n=== SITE LANGUAGES (auto-added) ===\nFrench\n=== END SITE LANGUAGES ===`,
        newAssets: assets,
        revisionRequest: '',
      }),
    ).toBe(false);
  });

  it('is not a no-op when an asset was added, removed or replaced', () => {
    const cases = [
      [...assets, { fileName: 'c.png', url: 'https://gw/ipfs/cid-c' }],
      [assets[0]],
      [assets[0], { fileName: 'b.png', url: 'https://gw/ipfs/cid-b2' }],
    ];
    for (const newAssets of cases) {
      expect(
        isNoOpRevision({
          basePrompt: PROMPT,
          baseAssets: assets,
          newPrompt: PROMPT,
          newAssets,
          revisionRequest: '',
        }),
      ).toBe(false);
    }
  });
});

describe('describeSettingsDelta', () => {
  it('reports nothing when the prompts match', () => {
    expect(describeSettingsDelta(PROMPT, PROMPT)).toEqual([]);
  });

  it('names the header fields that moved', () => {
    const next = PROMPT.replace('Palette: Warm', 'Palette: Grey tone').replace(
      'Category: Corporation',
      'Category: Personal',
    );
    const deltas = describeSettingsDelta(PROMPT, next);
    expect(deltas).toContain('Palette changed from "Warm" to "Grey tone".');
    expect(deltas).toContain('Category changed from "Corporation" to "Personal".');
  });

  it('reports added, removed and changed hidden blocks in plain words', () => {
    const added = `${PROMPT}\n\n=== SITE LANGUAGES (auto-added) ===\nFrench\n=== END SITE LANGUAGES ===`;
    expect(describeSettingsDelta(PROMPT, added)).toContain(
      'The user ADDED the site languages.',
    );
    expect(describeSettingsDelta(added, PROMPT)).toContain(
      'The user REMOVED the site languages.',
    );

    const changed = PROMPT.replace('Use a warm palette.', 'Use a cold palette.');
    expect(describeSettingsDelta(PROMPT, changed)).toContain(
      'The user CHANGED the color palette.',
    );
  });

  it('treats the contact form’s two header spellings as one section', () => {
    const short = `=== CONTACT FORM (auto-added) ===\nfields\n=== END CONTACT FORM ===\n\nUser request:\nWebsite Name: A\nCategory: Other`;
    const long = `=== CONTACT FORM (auto-added — overrides the service's "NO forms with action URLs" rule) ===\nfields\n=== END CONTACT FORM ===\n\nUser request:\nWebsite Name: A\nCategory: Other`;
    expect(describeSettingsDelta(short, long)).toEqual([]);
  });

  it('notices an edited description', () => {
    const next = PROMPT.replace('A studio site for Aurora.', 'A studio site for Aurora and friends.');
    expect(describeSettingsDelta(PROMPT, next)).toContain(
      'The written description of the site was edited.',
    );
  });
});

describe('applyRevisionPatch', () => {
  it('keeps untouched files byte-identical', () => {
    const merged = applyRevisionPatch(
      BASE_FILES,
      [{ path: 'styles.css', content: ':root{--ink:#000}' }],
      [],
    );
    expect(merged.find((f) => f.path === 'index.html')!.content).toBe(
      BASE_FILES[0].content,
    );
    expect(merged.find((f) => f.path === 'about.html')!.content).toBe(
      BASE_FILES[2].content,
    );
    expect(merged.find((f) => f.path === 'styles.css')!.content).toBe(
      ':root{--ink:#000}',
    );
  });

  it('removes the files the model listed', () => {
    const merged = applyRevisionPatch(BASE_FILES, [], ['about.html']);
    expect(merged.map((f) => f.path)).toEqual(['index.html', 'styles.css']);
  });

  it('refuses to delete index.html', () => {
    const merged = applyRevisionPatch(BASE_FILES, [], ['index.html', 'about.html']);
    expect(merged.map((f) => f.path)).toContain('index.html');
    expect(merged.map((f) => f.path)).not.toContain('about.html');
  });

  it('prefers a rewrite over a delete for the same path', () => {
    const merged = applyRevisionPatch(
      BASE_FILES,
      [{ path: 'about.html', content: '<h1>New about</h1>' }],
      ['about.html'],
    );
    expect(merged.find((f) => f.path === 'about.html')!.content).toBe(
      '<h1>New about</h1>',
    );
  });

  it('keeps the existing file when the model returns it EMPTY', () => {
    // Blanking is not how removal is expressed — deleted_files is — so an
    // empty body reads as a truncated/dropped file, not an erasure.
    const merged = applyRevisionPatch(
      BASE_FILES,
      [{ path: 'styles.css', content: '   \n ' }],
      [],
    );
    expect(merged.find((f) => f.path === 'styles.css')!.content).toBe(
      BASE_FILES[1].content,
    );
  });

  it('adds genuinely new files', () => {
    const merged = applyRevisionPatch(
      BASE_FILES,
      [{ path: 'contact.html', content: '<h1>Contact</h1>' }],
      [],
    );
    expect(merged.map((f) => f.path)).toContain('contact.html');
    expect(merged).toHaveLength(4);
  });
});

describe('reviseWebsite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const revise = (
    client: Anthropic,
    over: Partial<Parameters<typeof reviseWebsite>[2]> = {},
  ) =>
    reviseWebsite(PROMPT, [], {
      anthropicClient: client,
      baseFiles: BASE_FILES,
      revisionRequest: 'Change the headline to "Aurora Design Studio".',
      settingsDelta: [],
      ...over,
    });

  it('runs exactly ONE pass — no brief, no polish', async () => {
    const { client, stream } = fakeClient([
      message(
        JSON.stringify({
          files: [{ path: 'index.html', content: '<h1>Aurora Design Studio</h1>' }],
        }),
      ),
    ]);
    await revise(client);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('sends the existing source and the change request, and asks for restraint', async () => {
    const { client, stream } = fakeClient([message(JSON.stringify({ files: [] }))]);
    await revise(client, { settingsDelta: ['Palette changed from "Warm" to "Cold".'] });

    const text = userText(stream);
    expect(text).toContain('<existing_files>');
    expect(text).toContain('<file path="index.html">');
    expect(text).toContain('Aurora Studio');
    expect(text).toContain('.hero{font-size:4rem}');
    expect(text).toContain('Change the headline to "Aurora Design Studio".');
    expect(text).toContain('Palette changed from "Warm" to "Cold".');
    expect(text).toContain('You are EDITING the existing website above');
    expect(text).toContain('BYTE-IDENTICAL');
    // The original brief must be marked as context, not as a work order.
    expect(text).toContain('CONTEXT ONLY');
  });

  /**
   * Assets are matched against the existing source by CID, not by URL.
   *
   * `asset.url` is absolute (the service must still fetch it to show the model
   * the picture) while a published site now references assets relatively
   * (`../<cid>`). A URL comparison would therefore never match, and every asset
   * would be re-downloaded and re-attached on every single revision — spending
   * the whole attachment budget to tell the model something the HTML in front
   * of it already says. The CID appears in BOTH forms, so one comparison
   * covers sites from either era.
   */
  describe('asset re-attachment', () => {
    const CID = 'bafybeicqqub6psgupgkv7vq7gvtvl75qsugbjckmxrdttto4ol5jjxufxy';
    const ASSET = {
      fileName: 'hero.jpg',
      type: 'image',
      url: `https://ipfs.filebase.io/ipfs/${CID}`,
    };
    const SKIPPED = 'already used in the existing site';

    const reviseWith = (
      client: Anthropic,
      baseFiles: Array<{ path: string; content: string }>,
    ) =>
      reviseWebsite(PROMPT, [ASSET], {
        anthropicClient: client,
        baseFiles,
        revisionRequest: 'Tweak the headline.',
        settingsDelta: [],
        tmpDir: os.tmpdir(),
      });

    it('does NOT re-attach an asset the site already uses RELATIVELY', async () => {
      const { client, stream } = fakeClient([message(JSON.stringify({ files: [] }))]);
      await reviseWith(client, [
        { path: 'index.html', content: `<img src="../${CID}">` },
      ]);
      expect(userText(stream)).toContain(SKIPPED);
    });

    it('does NOT re-attach one a LEGACY site uses absolutely', async () => {
      const { client, stream } = fakeClient([message(JSON.stringify({ files: [] }))]);
      await reviseWith(client, [
        { path: 'index.html', content: `<img src="https://gw.old/ipfs/${CID}">` },
      ]);
      expect(userText(stream)).toContain(SKIPPED);
    });

    it('DOES attach an asset the site has never used', async () => {
      const { client, stream } = fakeClient([message(JSON.stringify({ files: [] }))]);
      await reviseWith(client, [
        { path: 'index.html', content: '<h1>no images here</h1>' },
      ]);
      expect(userText(stream)).not.toContain(SKIPPED);
    });

    it('hands the model the RELATIVE reference, never the gateway URL', async () => {
      const { client, stream } = fakeClient([message(JSON.stringify({ files: [] }))]);
      await reviseWith(client, [
        { path: 'index.html', content: `<img src="../${CID}">` },
      ]);
      const text = userText(stream);
      expect(text).toContain(`../${CID}`);
      expect(text).not.toContain(ASSET.url);
    });
  });

  it('keeps the site exactly as it was when the model returns no changes', async () => {
    const { client } = fakeClient([message(JSON.stringify({ files: [] }))]);
    const files = await revise(client);
    expect(files).toEqual(BASE_FILES);
  });

  it('merges the patch and leaves every other file untouched', async () => {
    const { client } = fakeClient([
      message(
        JSON.stringify({
          files: [
            {
              path: 'index.html',
              content: '<!doctype html>\n<h1 class="hero">Aurora Design Studio</h1>\n<p>We design.</p>',
            },
          ],
        }),
      ),
    ]);
    const files = await revise(client);
    expect(files.find((f) => f.path === 'index.html')!.content).toContain(
      'Aurora Design Studio',
    );
    expect(files.find((f) => f.path === 'styles.css')!.content).toBe(
      BASE_FILES[1].content,
    );
    expect(files.find((f) => f.path === 'about.html')!.content).toBe(
      BASE_FILES[2].content,
    );
  });

  it('honors deleted_files', async () => {
    const { client } = fakeClient([
      message(JSON.stringify({ files: [], deleted_files: ['about.html'] })),
    ]);
    const files = await revise(client, { revisionRequest: 'Remove the about page.' });
    expect(files.map((f) => f.path)).toEqual(['index.html', 'styles.css']);
  });

  it('retries a truncated edit by asking for fewer files, never a smaller site', async () => {
    const { client, stream } = fakeClient([
      message('{"files":[{"path":"index.html","content":"<h1>trunc', 'max_tokens'),
      message(JSON.stringify({ files: [{ path: 'index.html', content: '<h1>Ok</h1>' }] })),
    ]);
    const files = await revise(client);
    expect(files.find((f) => f.path === 'index.html')!.content).toBe('<h1>Ok</h1>');

    const retry = stream.mock.calls[1][0] as Anthropic.MessageStreamParams;
    const retryText = JSON.stringify(retry.messages[retry.messages.length - 1].content);
    expect(retryText).toContain('ONLY the files that genuinely must change');
    expect(retryText).not.toContain('60%');
  });

  it('fails with a useful message when the edit truncates twice', async () => {
    const { client } = fakeClient([
      message('{"files":[', 'max_tokens'),
      message('{"files":[', 'max_tokens'),
    ]);
    await expect(revise(client)).rejects.toThrow(/too large to apply in one edit/i);
  });

  it('repairs an unparseable response instead of failing the edit', async () => {
    const { client, stream } = fakeClient([
      message('Sure! Here you go: not json'),
      message(JSON.stringify({ files: [{ path: 'index.html', content: '<h1>Fixed</h1>' }] })),
    ]);
    const files = await revise(client);
    expect(files.find((f) => f.path === 'index.html')!.content).toBe('<h1>Fixed</h1>');
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('tolerates a fenced JSON response', async () => {
    const { client } = fakeClient([
      message('```json\n{"files":[{"path":"index.html","content":"<h1>Fenced</h1>"}]}\n```'),
    ]);
    const files = await revise(client);
    expect(files.find((f) => f.path === 'index.html')!.content).toBe('<h1>Fenced</h1>');
  });

  it('refuses to revise without the existing source', async () => {
    const { client } = fakeClient([]);
    await expect(revise(client, { baseFiles: [] })).rejects.toThrow(
      /requires the existing site source/i,
    );
  });
});
