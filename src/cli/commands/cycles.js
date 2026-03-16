import { findCycles, formatCycles } from '../../domain/graph/cycles.js';
import { openGraph } from '../shared/open-graph.js';

export const command = {
  name: 'cycles',
  description: 'Detect circular dependencies in the codebase',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--functions', 'Function-level cycle detection'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
  ],
  execute(_args, opts, ctx) {
    const { db, close } = openGraph(opts);
    const cycles = findCycles(db, {
      fileLevel: !opts.functions,
      noTests: ctx.resolveNoTests(opts),
    });
    close();

    if (opts.json) {
      console.log(JSON.stringify({ cycles, count: cycles.length }, null, 2));
    } else {
      console.log(formatCycles(cycles));
    }
  },
};
