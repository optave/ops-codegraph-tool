import { fileExports } from '../../presentation/queries-cli.js';

export const command = {
  name: 'exports <file>',
  description: 'Show exported symbols with per-symbol consumers (who calls each export)',
  queryOpts: true,
  options: [['--unused', 'Show only exports with zero consumers (dead exports)']],
  execute([file], opts, ctx) {
    fileExports(file, opts.db, {
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      unused: opts.unused || false,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  },
};
