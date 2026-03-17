import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';

export const command = {
  name: 'cfg <name>',
  description: 'Show control flow graph for a function',
  queryOpts: true,
  options: [
    ['--format <fmt>', 'Output format: text, dot, mermaid', 'text'],
    ['-f, --file <path>', 'Scope to file (partial match)'],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
  ],
  validate([_name], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([name], opts, ctx) {
    const { cfg } = await import('../../presentation/cfg.js');
    cfg(name, opts.db, {
      format: opts.format,
      file: opts.file,
      kind: opts.kind,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
