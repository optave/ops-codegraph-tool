import { stats } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'stats',
  description: 'Show graph health overview: nodes, edges, languages, cycles, hotspots, embeddings',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
  ],
  async execute(_args, opts, ctx) {
    await stats(opts.db, { noTests: ctx.resolveNoTests(opts), json: opts.json });
  },
};
