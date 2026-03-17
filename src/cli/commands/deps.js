import { fileDeps } from '../../presentation/queries-cli.js';

export const command = {
  name: 'deps <file>',
  description: 'Show what this file imports and what imports it',
  queryOpts: true,
  execute([file], opts, ctx) {
    fileDeps(file, opts.db, {
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
