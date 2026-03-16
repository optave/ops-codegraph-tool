import path from 'node:path';
import { buildEmbeddings, DEFAULT_MODEL, EMBEDDING_STRATEGIES } from '../../domain/search/index.js';

export const command = {
  name: 'embed [dir]',
  description:
    'Build semantic embeddings for all functions/methods/classes (requires prior `build`)',
  options: [
    [
      '-m, --model <name>',
      'Embedding model (default from config or minilm). Run `codegraph models` for details',
    ],
    [
      '-s, --strategy <name>',
      `Embedding strategy: ${EMBEDDING_STRATEGIES.join(', ')}. "structured" uses graph context (callers/callees), "source" embeds raw code`,
      'structured',
    ],
    ['-d, --db <path>', 'Path to graph.db'],
  ],
  validate([_dir], opts) {
    if (!EMBEDDING_STRATEGIES.includes(opts.strategy)) {
      return `Unknown strategy: ${opts.strategy}. Available: ${EMBEDDING_STRATEGIES.join(', ')}`;
    }
  },
  async execute([dir], opts, ctx) {
    const root = path.resolve(dir || '.');
    const model = opts.model || ctx.config.embeddings?.model || DEFAULT_MODEL;
    await buildEmbeddings(root, model, opts.db, { strategy: opts.strategy });
  },
};
