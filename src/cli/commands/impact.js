import { impactAnalysis } from '../../presentation/queries-cli.js';

export const command = {
  name: 'impact <file>',
  description: 'Show what depends on this file (transitive)',
  queryOpts: true,
  execute([file], opts, ctx) {
    impactAnalysis(file, opts.db, {
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
