import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { implementations } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'implementations <name>',
  description: 'List all concrete types implementing a given interface or trait',
  queryOpts: true,
  options: [
    [
      '-f, --file <path>',
      'Scope search to symbols in this file (partial match, repeatable)',
      collectFile,
    ],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
  ],
  validate([_name], opts) {
    if (opts.kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([name], opts, ctx) {
    implementations(name, opts.db, {
      file: opts.file,
      kind: opts.kind,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
