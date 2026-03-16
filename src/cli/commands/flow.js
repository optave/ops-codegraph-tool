import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';

export const command = {
  name: 'flow [name]',
  description:
    'Trace execution flow forward from an entry point (route, command, event) through callees to leaves',
  queryOpts: true,
  options: [
    ['--list', 'List all entry points grouped by type'],
    ['--depth <n>', 'Max forward traversal depth', '10'],
    ['-f, --file <path>', 'Scope to a specific file (partial match)'],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
  ],
  validate([name], opts) {
    if (!name && !opts.list) {
      return 'Provide a function/entry point name or use --list to see all entry points.';
    }
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([name], opts, ctx) {
    const { flow } = await import('../../commands/flow.js');
    flow(name, opts.db, {
      list: opts.list,
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  },
};
