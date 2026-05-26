import path from 'node:path';
import { openReadonlyOrFail } from '../../db/index.js';
import { getEmbeddingMeta } from '../../db/repository/embeddings.js';
import {
  buildEmbeddings,
  DEFAULT_MODEL,
  EMBEDDING_STRATEGIES,
  MODELS,
} from '../../domain/search/index.js';
import { info } from '../../infrastructure/logger.js';
import type { CommandDefinition } from '../types.js';

function resolveStickyModel(dbPath: string | undefined): string | null {
  try {
    const db = openReadonlyOrFail(dbPath);
    try {
      const storedName = getEmbeddingMeta(db, 'model');
      if (!storedName) return null;
      for (const [key, cfg] of Object.entries(MODELS)) {
        if (cfg.name === storedName) return key;
      }
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
      'Embedding model. Defaults to the model used by existing embeddings, or config, or the built-in default. Run `codegraph models` for options',
    ],
    [
      '-s, --strategy <name>',
      `Embedding strategy: ${EMBEDDING_STRATEGIES.join(', ')}. "structured" uses graph context (callers/callees), "source" embeds raw code`,
      'structured',
    ],
    ['-d, --db <path>', 'Path to graph.db'],
  ],
  validate([_dir], opts) {
    if (!(EMBEDDING_STRATEGIES as readonly string[]).includes(opts.strategy)) {
      return `Unknown strategy: ${opts.strategy}. Available: ${EMBEDDING_STRATEGIES.join(', ')}`;
    }
  },
  async execute([dir], opts, ctx) {
    const root = path.resolve(dir || '.');
    const dbPath = opts.db as string | undefined;
    const embeddingsConfig = ctx.config.embeddings;
    const flagModel = opts.model as string | undefined;
    const configModel = (embeddingsConfig?.model as string | null | undefined) ?? null;

    let model: string;
    if (flagModel) {
      model = flagModel;
    } else if (configModel) {
      model = configModel;
    } else {
      const sticky = resolveStickyModel(dbPath);
      if (sticky) {
        info(
          `Reusing previously-stored embedding model "${sticky}". Pass --model to switch, or set embeddings.model in your config.`,
        );
        model = sticky;
      } else {
        model = DEFAULT_MODEL;
      }
    }

    await buildEmbeddings(root, model, dbPath, { strategy: opts.strategy });
  },
};
