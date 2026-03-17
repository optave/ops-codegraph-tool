import { brief } from '../../presentation/brief.js';
import { fileDeps } from '../../presentation/queries-cli.js';

export const command = {
  name: 'deps <file>',
  description: 'Show what this file imports and what imports it',
  queryOpts: true,
  options: [['--brief', 'Compact output with symbol roles, caller counts, and risk tier']],
  execute([file], opts, ctx) {
    const qOpts = ctx.resolveQueryOpts(opts);
    if (opts.brief) {
      brief(file, opts.db, qOpts);
    } else {
      fileDeps(file, opts.db, qOpts);
    }
  },
};
