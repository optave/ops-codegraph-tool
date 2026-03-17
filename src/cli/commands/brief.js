import { brief } from '../../presentation/brief.js';

export const command = {
  name: 'brief <file>',
  description: 'Token-efficient file summary: symbols with roles, caller counts, risk tier',
  queryOpts: true,
  execute([file], opts, ctx) {
    brief(file, opts.db, {
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
