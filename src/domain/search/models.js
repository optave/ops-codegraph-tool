import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ConfigError, EngineError } from '../../shared/errors.js';
import { info } from '../../infrastructure/logger.js';

// Lazy-load transformers (heavy, optional module)
let pipeline = null;
let extractor = null;
let activeModel = null;

export const MODELS = {
  minilm: {
    name: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    contextWindow: 256,
    desc: 'Smallest, fastest (~23MB). General text.',
    quantized: true,
  },
  'jina-small': {
    name: 'Xenova/jina-embeddings-v2-small-en',
    dim: 512,
    contextWindow: 8192,
    desc: 'Small, good quality (~33MB). General text.',
    quantized: false,
  },
  'jina-base': {
    name: 'Xenova/jina-embeddings-v2-base-en',
    dim: 768,
    contextWindow: 8192,
    desc: 'Good quality (~137MB). General text, 8192 token context.',
    quantized: false,
  },
  'jina-code': {
    name: 'Xenova/jina-embeddings-v2-base-code',
    dim: 768,
    contextWindow: 8192,
    desc: 'Code-aware (~137MB). Trained on code+text, best for code search.',
    quantized: false,
  },
  nomic: {
    name: 'Xenova/nomic-embed-text-v1',
    dim: 768,
    contextWindow: 8192,
    desc: 'Good local quality (~137MB). 8192 context.',
    quantized: false,
  },
  'nomic-v1.5': {
    name: 'nomic-ai/nomic-embed-text-v1.5',
    dim: 768,
    contextWindow: 8192,
    desc: 'Improved nomic (~137MB). Matryoshka dimensions, 8192 context.',
    quantized: false,
  },
  'bge-large': {
    name: 'Xenova/bge-large-en-v1.5',
    dim: 1024,
    contextWindow: 512,
    desc: 'Best general retrieval (~335MB). Top MTEB scores.',
    quantized: false,
  },
};

export const EMBEDDING_STRATEGIES = ['structured', 'source'];

export const DEFAULT_MODEL = 'nomic-v1.5';
const BATCH_SIZE_MAP = {
  minilm: 32,
  'jina-small': 16,
  'jina-base': 8,
  'jina-code': 8,
  nomic: 8,
  'nomic-v1.5': 8,
  'bge-large': 4,
};
const DEFAULT_BATCH_SIZE = 32;

/** @internal Used by generator.js — not part of the public barrel. */
export function getModelConfig(modelKey) {
  const key = modelKey || DEFAULT_MODEL;
  const config = MODELS[key];
  if (!config) {
    throw new ConfigError(`Unknown model: ${key}. Available: ${Object.keys(MODELS).join(', ')}`);
  }
  return config;
}

/**
 * Prompt the user to install a missing package interactively.
 * Returns true if the package was installed, false otherwise.
 * Skips the prompt entirely in non-TTY environments (CI, piped stdin).
 * @internal Not part of the public barrel.
 */
export function promptInstall(packageName) {
  if (!process.stdin.isTTY) return Promise.resolve(false);

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Semantic search requires ${packageName}. Install it now? [y/N] `, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') return resolve(false);
      try {
        execFileSync('npm', ['install', packageName], {
          stdio: 'inherit',
          timeout: 300_000,
        });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Lazy-load @huggingface/transformers.
 * If the package is missing, prompts the user to install it interactively.
 * In non-TTY environments, prints an error and exits.
 * @internal Not part of the public barrel.
 */
export async function loadTransformers() {
  try {
    return await import('@huggingface/transformers');
  } catch {
    const pkg = '@huggingface/transformers';
    const installed = await promptInstall(pkg);
    if (installed) {
      try {
        return await import(pkg);
      } catch (loadErr) {
        throw new EngineError(
          `${pkg} was installed but failed to load. Please check your environment.`,
          { cause: loadErr },
        );
      }
    }
    throw new EngineError(`Semantic search requires ${pkg}.\nInstall it with: npm install ${pkg}`);
  }
}

/**
 * Dispose the current ONNX session and free memory.
 * Safe to call when no model is loaded (no-op).
 */
export async function disposeModel() {
  if (extractor) {
    await extractor.dispose();
    extractor = null;
  }
  activeModel = null;
}

async function loadModel(modelKey) {
  const config = getModelConfig(modelKey);

  if (extractor && activeModel === config.name) return { extractor, config };

  // Dispose previous model before loading a different one
  await disposeModel();

  const transformers = await loadTransformers();
  pipeline = transformers.pipeline;

  info(`Loading embedding model: ${config.name} (${config.dim}d)...`);
  const pipelineOpts = config.quantized ? { quantized: true } : {};
  try {
    extractor = await pipeline('feature-extraction', config.name, pipelineOpts);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('Unauthorized') || msg.includes('401') || msg.includes('gated')) {
      throw new EngineError(
        `Model "${config.name}" requires authentication.\n` +
          `This model is gated on HuggingFace and needs an access token.\n\n` +
          `Options:\n` +
          `  1. Set HF_TOKEN env var: export HF_TOKEN=hf_...\n` +
          `  2. Use a public model instead: codegraph embed --model minilm`,
        { cause: err },
      );
    }
    throw new EngineError(
      `Failed to load model "${config.name}": ${msg}\n` +
        `Try a different model: codegraph embed --model minilm`,
      { cause: err },
    );
  }
  activeModel = config.name;
  info('Model loaded.');
  return { extractor, config };
}

/**
 * Generate embeddings for an array of texts.
 */
export async function embed(texts, modelKey) {
  const { extractor: ext, config } = await loadModel(modelKey);
  const dim = config.dim;
  const results = [];
  const batchSize = BATCH_SIZE_MAP[modelKey || DEFAULT_MODEL] || DEFAULT_BATCH_SIZE;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await ext(batch, { pooling: 'mean', normalize: true });

    for (let j = 0; j < batch.length; j++) {
      const start = j * dim;
      const vec = new Float32Array(dim);
      for (let k = 0; k < dim; k++) {
        vec[k] = output.data[start + k];
      }
      results.push(vec);
    }

    if (texts.length > batchSize) {
      process.stdout.write(`  Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}\r`);
    }
  }

  return { vectors: results, dim };
}
