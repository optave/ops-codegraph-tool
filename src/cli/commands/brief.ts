import { brief } from '../../presentation/brief.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'brief <file>',
  description: 'Token-efficient file summary: symbols with roles, caller counts, risk tier',
  queryOpts: true,
  execute([file], opts, ctx) {
    brief(file, opts.db, {
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
