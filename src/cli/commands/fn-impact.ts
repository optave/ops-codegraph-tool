import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { fnImpact } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'fn-impact <name>',
  description: 'Function-level impact: what functions break if this one changes',
  queryOpts: true,
  options: [
    ['--depth <n>', 'Max transitive depth', '5'],
    [
      '-f, --file <path>',
      'Scope search to functions in this file (partial match, repeatable)',
      collectFile,
    ],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
    ['--no-implementations', 'Exclude interface/trait implementors from blast radius'],
  ],
  validate([_name], opts) {
    if (opts.kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([name], opts, ctx) {
    fnImpact(name, opts.db, {
      depth: parseInt(opts.depth as string, 10),
      file: opts.file,
      kind: opts.kind,
      includeImplementors: opts.implementations !== false,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
