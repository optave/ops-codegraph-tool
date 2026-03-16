import { where } from '../../presentation/queries-cli.js';

export const command = {
  name: 'where [name]',
  description: 'Find where a symbol is defined and used (minimal, fast lookup)',
  queryOpts: true,
  options: [['-f, --file <path>', 'File overview: list symbols, imports, exports']],
  validate([name], opts) {
    if (!name && !opts.file) {
      return 'Provide a symbol name or use --file <path>';
    }
  },
  execute([name], opts, ctx) {
    const target = opts.file || name;
    where(target, opts.db, {
      file: !!opts.file,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  },
};
