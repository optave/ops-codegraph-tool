import { ConfigError, EngineError } from '../../../shared/errors.js';
import type { CodegraphConfig } from '../../../types.js';

/** Batch size for remote `/embeddings` requests. Conservative default — most
 * OpenAI-compatible servers accept much larger batches, but this keeps
 * individual request bodies and timeouts predictable across unknown hosts. */
const REMOTE_BATCH_SIZE = 32;

/**
 * Context window assumed for remote models when truncating oversized symbols.
 * Remote model context limits aren't known ahead of time (unlike the local
 * registry in `models.ts`), so this is a conservative default matching most
 * modern embedding models rather than a per-model lookup.
 */
export const DEFAULT_REMOTE_CONTEXT_WINDOW = 8192;

export interface RemoteEmbeddingOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}

interface OpenAIEmbeddingItem {
  embedding: number[];
  index: number;
}

interface OpenAIEmbeddingResponse {
  data: OpenAIEmbeddingItem[];
}

function embeddingsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`;
}

/**
 * Resolve the remote embedding endpoint config from `llm.*`, given the
 * already-resolved model identifier (from `--model` / `embeddings.model`).
 * Throws a ConfigError if `llm.baseUrl` isn't set — there's no sensible
 * default host for a self-hosted endpoint.
 */
export function resolveRemoteEmbeddingOptions(
  config: Pick<CodegraphConfig, 'llm'>,
  model: string,
): RemoteEmbeddingOptions {
  const baseUrl = config.llm.baseUrl;
  if (!baseUrl) {
    throw new ConfigError(
      'embeddings.provider is "openai" but llm.baseUrl is not set. ' +
        'Point it at your embeddings endpoint, e.g. "http://localhost:8080/v1" ' +
        '(config key "llm.baseUrl" or env var CODEGRAPH_LLM_BASE_URL).',
    );
  }
  return { baseUrl, model, apiKey: config.llm.apiKey };
}

/**
 * Generate embeddings via a remote OpenAI-compatible `/embeddings` endpoint.
 * Works with OpenAI itself and any self-hosted server implementing the same
 * request/response shape (text-embeddings-inference, Ollama, LM Studio, vLLM).
 */
export async function embedRemote(
  texts: string[],
  options: RemoteEmbeddingOptions,
): Promise<{ vectors: Float32Array[]; dim: number }> {
  if (texts.length === 0) return { vectors: [], dim: 0 };

  const url = embeddingsEndpoint(options.baseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  const results: Float32Array[] = [];
  let dim = 0;

  for (let i = 0; i < texts.length; i += REMOTE_BATCH_SIZE) {
    const batch = texts.slice(i, i + REMOTE_BATCH_SIZE);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: options.model, input: batch }),
      });
    } catch (err: unknown) {
      throw new EngineError(
        `Failed to reach remote embedding endpoint at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new EngineError(
        `Remote embedding endpoint ${url} returned ${response.status} ${response.statusText}` +
          (body ? `: ${body.slice(0, 500)}` : ''),
      );
    }

    const json = (await response.json()) as OpenAIEmbeddingResponse;
    if (!Array.isArray(json.data) || json.data.length !== batch.length) {
      throw new EngineError(
        `Remote embedding endpoint ${url} returned an unexpected response shape ` +
          `(expected ${batch.length} embeddings, got ${json.data?.length ?? 0})`,
      );
    }

    // OpenAI-compatible servers aren't guaranteed to preserve input order — sort by index.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      const vec = Float32Array.from(item.embedding);
      if (dim === 0) dim = vec.length;
      results.push(vec);
    }

    if (texts.length > REMOTE_BATCH_SIZE) {
      process.stderr.write(
        `  Embedded ${Math.min(i + REMOTE_BATCH_SIZE, texts.length)}/${texts.length}\r`,
      );
    }
  }

  return { vectors: results, dim };
}
