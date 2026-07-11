import path from 'node:path';
import { openReadonlyOrFail, resolveBusyTimeoutMs } from '../../db/index.js';
import { getEmbeddingMeta } from '../../db/repository/embeddings.js';
import {
  buildEmbeddings,
  DEFAULT_MODEL,
  EMBEDDING_STRATEGIES,
  MODELS,
  resolveRemoteEmbeddingOptions,
} from '../../domain/search/index.js';
import { info, warn } from '../../infrastructure/logger.js';
import type { CommandDefinition } from '../types.js';

function resolveStickyModel(dbPath: string | undefined, rootDir: string): string | null {
  try {
    const db = openReadonlyOrFail(dbPath, resolveBusyTimeoutMs(dbPath ?? rootDir), rootDir);
    try {
      const storedName = getEmbeddingMeta(db, 'model');
      if (!storedName) return null;
      for (const [key, cfg] of Object.entries(MODELS)) {
        if (cfg.name === storedName) return key;
      }
      warn(
        `Stored embedding model "${storedName}" is no longer recognised — falling back to default. ` +
          'Embeddings will be rebuilt with the new model.',
      );
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export const command: CommandDefinition = {
  name: 'embed [dir]',
  description:
    'Build semantic embeddings for all functions/methods/classes (requires prior `build`)',
  options: [
    [
      '-m, --model <name>',
      'Embedding model. Defaults to config, then the model used by existing embeddings, then the built-in default. Run `codegraph models` for options',
    ],
    [
      '-s, --strategy <name>',
      `Embedding strategy: ${EMBEDDING_STRATEGIES.join(', ')}. "structured" uses graph context (callers/callees), "source" embeds raw code`,
      'structured',
    ],
    ['-d, --db <path>', 'Path to graph.db (default: <dir>/.codegraph/graph.db)'],
  ],
  validate([_dir], opts, ctx) {
    if (!(EMBEDDING_STRATEGIES as readonly string[]).includes(opts.strategy)) {
      return `Unknown strategy: ${opts.strategy}. Available: ${EMBEDDING_STRATEGIES.join(', ')}`;
    }
    const provider = ctx.config.embeddings?.provider ?? null;
    if (provider && provider !== 'openai') {
      return (
        `Unsupported embeddings.provider "${provider}". Currently supported: "openai" ` +
        '(any OpenAI-compatible /embeddings endpoint, including self-hosted servers).'
      );
    }
    if (provider && !opts.model && !ctx.config.embeddings?.model) {
      return (
        `embeddings.provider is set to "${provider}" but no model is configured. ` +
        'Set embeddings.model to the model identifier your endpoint expects, or pass --model.'
      );
    }
  },
  async execute([dir], opts, ctx) {
    const root = path.resolve(dir || '.');
    const dbPath = opts.db as string | undefined;
    const embeddingsConfig = ctx.config.embeddings;
    const provider = embeddingsConfig?.provider ?? null;
    const flagModel = opts.model as string | undefined;
    const configModel = (embeddingsConfig?.model as string | null | undefined) ?? null;

    let model: string;
    if (flagModel) {
      model = flagModel;
    } else if (configModel) {
      model = configModel;
    } else if (provider) {
      // Unreachable in practice — validate() rejects a provider with no model
      // before execute() runs — but keeps this branch type-safe.
      model = DEFAULT_MODEL;
    } else {
      const sticky = resolveStickyModel(dbPath, root);
      if (sticky) {
        info(
          `Reusing previously-stored embedding model "${sticky}". Pass --model to switch, or set embeddings.model in your config.`,
        );
        model = sticky;
      } else {
        model = DEFAULT_MODEL;
      }
    }

    const remote =
      provider === 'openai' ? resolveRemoteEmbeddingOptions(ctx.config, model) : undefined;
    await buildEmbeddings(root, model, dbPath, { strategy: opts.strategy, remote });
  },
};
