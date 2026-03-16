import { fileDeps } from '../../queries-cli.js';

export const command = {
  name: 'deps <file>',
  description: 'Show what this file imports and what imports it',
  queryOpts: true,
  execute([file], opts, ctx) {
    fileDeps(file, opts.db, {
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  },
};
