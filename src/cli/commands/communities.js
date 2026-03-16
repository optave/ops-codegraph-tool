export const command = {
  name: 'communities',
  description: 'Detect natural module boundaries using Louvain community detection',
  queryOpts: true,
  options: [
    ['--functions', 'Function-level instead of file-level'],
    ['--resolution <n>', 'Louvain resolution parameter (default 1.0)', '1.0'],
    ['--drift', 'Show only drift analysis'],
  ],
  async execute(_args, opts, ctx) {
    const { communities } = await import('../../commands/communities.js');
    communities(opts.db, {
      functions: opts.functions,
      resolution: parseFloat(opts.resolution),
      drift: opts.drift,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  },
};
