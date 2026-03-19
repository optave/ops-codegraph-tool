import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { interfaces } from '../../presentation/queries-cli.js';

export const command = {
  name: 'interfaces <name>',
  description: 'List all interfaces and traits that a class or struct implements',
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
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([name], opts, ctx) {
    interfaces(name, opts.db, {
      file: opts.file,
      kind: opts.kind,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
