import { fileExports } from '../../presentation/queries-cli.js';

export const command = {
  name: 'exports <file>',
  description: 'Show exported symbols with per-symbol consumers (who calls each export)',
  queryOpts: true,
  options: [['--unused', 'Show only exports with zero consumers (dead exports)']],
  execute([file], opts, ctx) {
    fileExports(file, opts.db, {
      unused: opts.unused || false,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
