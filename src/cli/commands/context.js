import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { context } from '../../presentation/queries-cli.js';

export const command = {
  name: 'context <name>',
  description: 'Full context for a function: source, deps, callers, tests, signature',
  queryOpts: true,
  options: [
    ['--depth <n>', 'Include callee source up to N levels deep', '0'],
    [
      '-f, --file <path>',
      'Scope search to functions in this file (partial match, repeatable)',
      collectFile,
    ],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
    ['--no-source', 'Metadata only (skip source extraction)'],
    ['--with-test-source', 'Include test source code'],
  ],
  validate([_name], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([name], opts, ctx) {
    context(name, opts.db, {
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      noSource: !opts.source,
      includeTests: opts.withTestSource,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
