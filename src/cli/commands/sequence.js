import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';

export const command = {
  name: 'sequence <name>',
  description: 'Generate a Mermaid sequence diagram from call graph edges (participants = files)',
  queryOpts: true,
  options: [
    ['--depth <n>', 'Max forward traversal depth', '10'],
    ['--dataflow', 'Annotate with parameter names and return arrows from dataflow table'],
    ['-f, --file <path>', 'Scope to a specific file (partial match)'],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
  ],
  validate([_name], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([name], opts, ctx) {
    const { sequence } = await import('../../presentation/sequence.js');
    sequence(name, opts.db, {
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      dataflow: opts.dataflow,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
