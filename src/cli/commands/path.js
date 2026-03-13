import { EVERY_SYMBOL_KIND } from '../../queries.js';
import { symbolPath } from '../../queries-cli.js';

export const command = {
  name: 'path <from> <to>',
  description: 'Find shortest path between two symbols',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--reverse', 'Follow edges backward'],
    ['--kinds <kinds>', 'Comma-separated edge kinds to follow (default: calls)'],
    ['--from-file <path>', 'Disambiguate source symbol by file'],
    ['--to-file <path>', 'Disambiguate target symbol by file'],
    ['--depth <n>', 'Max traversal depth', '10'],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
  ],
  validate([_from, _to], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([from, to], opts, ctx) {
    symbolPath(from, to, opts.db, {
      maxDepth: opts.depth ? parseInt(opts.depth, 10) : 10,
      edgeKinds: opts.kinds ? opts.kinds.split(',').map((s) => s.trim()) : undefined,
      reverse: opts.reverse,
      fromFile: opts.fromFile,
      toFile: opts.toFile,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
    });
  },
};
