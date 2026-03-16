import { impactAnalysis } from '../../queries-cli.js';

export const command = {
  name: 'impact <file>',
  description: 'Show what depends on this file (transitive)',
  queryOpts: true,
  execute([file], opts, ctx) {
    impactAnalysis(file, opts.db, {
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  },
};
