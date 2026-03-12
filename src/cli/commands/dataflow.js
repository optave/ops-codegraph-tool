import { EVERY_SYMBOL_KIND } from '../../queries.js';

export const command = {
  name: 'dataflow <name>',
  description: 'Show data flow for a function: parameters, return consumers, mutations',
  queryOpts: true,
  options: [
    ['-f, --file <path>', 'Scope to file (partial match)'],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
    ['--impact', 'Show data-dependent blast radius'],
    ['--depth <n>', 'Max traversal depth', '5'],
  ],
  validate([_name], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([name], opts, ctx) {
    const { dataflow } = await import('../../commands/dataflow.js');
    dataflow(name, opts.db, {
      file: opts.file,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      ndjson: opts.ndjson,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      impact: opts.impact,
      depth: opts.depth,
    });
  },
};
