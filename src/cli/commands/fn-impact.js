import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { fnImpact } from '../../presentation/queries-cli.js';

export const command = {
  name: 'fn-impact <name>',
  description: 'Function-level impact: what functions break if this one changes',
  queryOpts: true,
  options: [
    ['--depth <n>', 'Max transitive depth', '5'],
    ['-f, --file <path>', 'Scope search to functions in this file (partial match)'],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
  ],
  validate([_name], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([name], opts, ctx) {
    fnImpact(name, opts.db, {
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
