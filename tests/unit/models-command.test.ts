import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { command } from '../../src/cli/commands/models.js';

function fakeCtx(embeddings: Record<string, unknown>) {
  return {
    config: {
      embeddings: { model: null, llmProvider: null, provider: null, ...embeddings },
    },
  } as never;
}

describe('models command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('does not print the literal string "null" when a remote provider has no model configured', () => {
    command.execute!([], {} as never, fakeCtx({ provider: 'openai' }));

    const banner = logSpy.mock.calls.map((call) => call[0]).find((line) => /openai/.test(line));
    expect(banner).toBeDefined();
    expect(banner).not.toMatch(/model "null"/);
    expect(banner).toMatch(/not configured/);
  });

  it('prints the configured model name when a remote provider has a model set', () => {
    command.execute!(
      [],
      {} as never,
      fakeCtx({ provider: 'openai', model: 'text-embedding-3-small' }),
    );

    const banner = logSpy.mock.calls.map((call) => call[0]).find((line) => /openai/.test(line));
    expect(banner).toMatch(/model "text-embedding-3-small"/);
  });
});
