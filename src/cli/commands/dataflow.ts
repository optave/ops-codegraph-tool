import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'dataflow <name>',
  description: 'Show data flow for a function: parameters, return consumers, mutations',
  queryOpts: true,
  options: [
    ['-f, --file <path>', 'Scope to file (partial match, repeatable)', collectFile],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
    ['--impact', 'Show data-dependent blast radius'],
    ['--depth <n>', 'Max traversal depth', '5'],
  ],
  validate([_name], opts) {
    if (opts.kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([name], opts, ctx) {
    const { dataflow } = await import('../../presentation/dataflow.js');
    dataflow(name, opts.db, {
      file: opts.file,
      kind: opts.kind,
      impact: opts.impact,
      depth: parseInt(opts.depth as string, 10),
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
