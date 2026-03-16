import { openReadonlyOrFail } from '../../db/index.js';
import { findCycles, formatCycles } from '../../domain/graph/cycles.js';

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
    const db = openReadonlyOrFail(opts.db);
    const cycles = findCycles(db, {
      fileLevel: !opts.functions,
      noTests: ctx.resolveNoTests(opts),
    });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ cycles, count: cycles.length }, null, 2));
    } else {
      console.log(formatCycles(cycles));
    }
  },
};
