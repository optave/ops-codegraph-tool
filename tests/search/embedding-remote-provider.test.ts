import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  embedRemote,
  resolveRemoteEmbeddingOptions,
} from '../../src/domain/search/providers/remote.js';
import { ConfigError, EngineError } from '../../src/shared/errors.js';

describe('resolveRemoteEmbeddingOptions', () => {
  it('builds options from llm config', () => {
    const options = resolveRemoteEmbeddingOptions(
      {
        llm: {
          provider: 'openai',
          model: null,
          baseUrl: 'http://localhost:8080/v1',
          apiKey: 'sk-test',
          apiKeyCommand: null,
        },
      },
      'my-embed-model',
    );
    expect(options).toEqual({
      baseUrl: 'http://localhost:8080/v1',
      model: 'my-embed-model',
      apiKey: 'sk-test',
    });
  });

  it('throws ConfigError when llm.baseUrl is not set', () => {
    expect(() =>
      resolveRemoteEmbeddingOptions(
        {
          llm: {
            provider: 'openai',
            model: null,
            baseUrl: null,
            apiKey: null,
            apiKeyCommand: null,
          },
        },
        'my-embed-model',
      ),
    ).toThrow(ConfigError);
  });
});

describe('embedRemote', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('returns an empty result without a network call for empty input', async () => {
    const result = await embedRemote([], { baseUrl: 'http://localhost:8080/v1', model: 'm' });
    expect(result).toEqual({ vectors: [], dim: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to <baseUrl>/embeddings and parses an OpenAI-shaped response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [0.1, 0.2, 0.3], index: 0 },
            { embedding: [0.4, 0.5, 0.6], index: 1 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await embedRemote(['a', 'b'], {
      baseUrl: 'http://localhost:8080/v1',
      model: 'my-model',
      apiKey: 'sk-test',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toEqual({ model: 'my-model', input: ['a', 'b'] });

    expect(result.dim).toBe(3);
    expect(result.vectors).toHaveLength(2);
    // Compare against Float32-rounded expectations — embedRemote stores vectors
    // as Float32Array, which loses precision relative to the JSON doubles.
    expect(Array.from(result.vectors[0])).toEqual(Array.from(Float32Array.from([0.1, 0.2, 0.3])));
    expect(Array.from(result.vectors[1])).toEqual(Array.from(Float32Array.from([0.4, 0.5, 0.6])));
  });

  it('does not double up when baseUrl already ends with /embeddings', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [1], index: 0 }] }), { status: 200 }),
    );
    await embedRemote(['x'], { baseUrl: 'http://localhost:8080/v1/embeddings', model: 'm' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/v1/embeddings');
  });

  it('sorts response items by index to restore input order', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [2], index: 1 },
            { embedding: [1], index: 0 },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await embedRemote(['a', 'b'], { baseUrl: 'http://x', model: 'm' });
    expect(Array.from(result.vectors[0])).toEqual([1]);
    expect(Array.from(result.vectors[1])).toEqual([2]);
  });

  it('omits the Authorization header when no apiKey is configured', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [1], index: 0 }] }), { status: 200 }),
    );
    await embedRemote(['a'], { baseUrl: 'http://x', model: 'm' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('batches requests larger than the batch size', async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `text-${i}`);
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const data = body.input.map((_text: string, i: number) => ({ embedding: [1], index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const result = await embedRemote(texts, { baseUrl: 'http://x', model: 'm' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 32 + 8
    expect(result.vectors).toHaveLength(40);
  });

  it('throws EngineError on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('bad request', { status: 400, statusText: 'Bad Request' }),
    );
    await expect(embedRemote(['a'], { baseUrl: 'http://x', model: 'm' })).rejects.toThrow(
      EngineError,
    );
  });

  it('throws EngineError when the response shape does not match the input length', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [1], index: 0 }] }), { status: 200 }),
    );
    await expect(embedRemote(['a', 'b'], { baseUrl: 'http://x', model: 'm' })).rejects.toThrow(
      EngineError,
    );
  });

  it('throws EngineError when the network request itself fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(embedRemote(['a'], { baseUrl: 'http://x', model: 'm' })).rejects.toThrow(
      EngineError,
    );
  });
});
