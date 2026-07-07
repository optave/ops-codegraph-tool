import type { Cycle } from '../../domain/graph/cycles.js';
import { findCycles, formatCycles } from '../../domain/graph/cycles.js';
import { openGraph } from '../shared/open-graph.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'cycles',
  description: 'Detect circular dependencies in the codebase',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--functions', 'Function-level cycle detection'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    [
      '--exclude-speculative',
      'Exclude cycles whose only closing edges are low-confidence dynamic calls',
    ],
    ['-j, --json', 'Output as JSON'],
  ],
  execute(_args, opts, ctx) {
    const { db, close } = openGraph(opts as { db?: string });
    let cycles: Cycle[];
    try {
      cycles = findCycles(db, {
        fileLevel: !opts.functions,
        noTests: ctx.resolveNoTests(opts),
        excludeSpeculative: Boolean(opts.excludeSpeculative),
      });
    } finally {
      close();
    }

    if (opts.json) {
      console.log(JSON.stringify({ cycles, count: cycles.length }, null, 2));
    } else {
      console.log(formatCycles(cycles));
    }
  },
};
