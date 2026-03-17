import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { children } from '../../presentation/queries-cli.js';

export const command = {
  name: 'children <name>',
  description: 'List parameters, properties, and constants of a symbol',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-f, --file <path>', 'Scope search to symbols in this file (partial match)'],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['-j, --json', 'Output as JSON'],
    ['--limit <number>', 'Max results to return'],
    ['--offset <number>', 'Skip N results (default: 0)'],
  ],
  validate([_name], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([name], opts, ctx) {
    children(name, opts.db, {
      file: opts.file,
      kind: opts.kind,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
