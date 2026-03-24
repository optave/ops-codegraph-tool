import { moduleMap } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'map',
  description: 'High-level module overview with most-connected nodes',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-n, --limit <number>', 'Number of top nodes', '20'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
  ],
  execute(_args, opts, ctx) {
    moduleMap(opts.db, parseInt(opts.limit as string, 10), {
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
    });
  },
};
