import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/domain/search/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildEmbeddings: vi.fn() };
});
vi.mock('../../src/db/index.js', () => ({
  openReadonlyOrFail: vi.fn(() => {
    throw new Error('no db in this test');
  }),
}));
vi.mock('../../src/db/repository/embeddings.js', () => ({ getEmbeddingMeta: vi.fn() }));

const { command } = await import('../../src/cli/commands/embed.js');
const { buildEmbeddings } = await import('../../src/domain/search/index.js');

function fakeCtx(embeddings: Record<string, unknown>, llm: Record<string, unknown> = {}) {
  return {
    config: {
      embeddings: { model: null, llmProvider: null, provider: null, ...embeddings },
      llm: {
        provider: null,
        model: null,
        baseUrl: null,
        apiKey: null,
        apiKeyCommand: null,
        ...llm,
      },
    },
  } as never;
}

describe('embed command validate()', () => {
  it('rejects an unknown strategy', () => {
    const err = command.validate!([undefined], { strategy: 'bogus' } as never, fakeCtx({}));
    expect(err).toMatch(/Unknown strategy/);
  });

  it('rejects an unsupported embeddings.provider', () => {
    const err = command.validate!(
      [undefined],
      { strategy: 'structured' } as never,
      fakeCtx({ provider: 'anthropic' }),
    );
    expect(err).toMatch(/Unsupported embeddings.provider/);
  });

  it('rejects provider "openai" with no model configured', () => {
    const err = command.validate!(
      [undefined],
      { strategy: 'structured' } as never,
      fakeCtx({ provider: 'openai' }),
    );
    expect(err).toMatch(/no model is configured/);
  });

  it('accepts provider "openai" with a config model', () => {
    const err = command.validate!(
      [undefined],
      { strategy: 'structured' } as never,
      fakeCtx({ provider: 'openai', model: 'text-embedding-3-small' }),
    );
    expect(err).toBeUndefined();
  });

  it('accepts provider "openai" with a --model flag', () => {
    const err = command.validate!(
      [undefined],
      { strategy: 'structured', model: 'text-embedding-3-small' } as never,
      fakeCtx({ provider: 'openai' }),
    );
    expect(err).toBeUndefined();
  });

  it('accepts no provider at all', () => {
    const err = command.validate!([undefined], { strategy: 'structured' } as never, fakeCtx({}));
    expect(err).toBeUndefined();
  });
});

describe('embed command execute()', () => {
  beforeEach(() => {
    vi.mocked(buildEmbeddings).mockClear();
  });

  afterEach(() => {
    vi.mocked(buildEmbeddings).mockReset();
  });

  it('passes a resolved remote config through to buildEmbeddings when provider is "openai"', async () => {
    const ctx = fakeCtx(
      { provider: 'openai', model: 'text-embedding-3-small' },
      { baseUrl: 'http://localhost:8080/v1', apiKey: 'sk-test', requestTimeoutMs: 5000 },
    );

    await command.execute!([undefined], { strategy: 'structured' } as never, ctx);

    expect(buildEmbeddings).toHaveBeenCalledTimes(1);
    const [, model, , options] = vi.mocked(buildEmbeddings).mock.calls[0]!;
    expect(model).toBe('text-embedding-3-small');
    expect(options.remote).toEqual({
      baseUrl: 'http://localhost:8080/v1',
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      timeoutMs: 5000,
    });
  });

  it('does not build a remote config when no provider is set', async () => {
    const ctx = fakeCtx({ model: 'minilm' });

    await command.execute!([undefined], { strategy: 'structured' } as never, ctx);

    expect(buildEmbeddings).toHaveBeenCalledTimes(1);
    const [, , , options] = vi.mocked(buildEmbeddings).mock.calls[0]!;
    expect(options.remote).toBeUndefined();
  });
});
