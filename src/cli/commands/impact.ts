import { impactAnalysis } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'impact <file>',
  description: 'Show what depends on this file (transitive)',
  queryOpts: true,
  execute([file], opts, ctx) {
    impactAnalysis(file, opts.db, {
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
