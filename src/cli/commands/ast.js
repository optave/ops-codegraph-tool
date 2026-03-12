export const command = {
  name: 'ast [pattern]',
  description: 'Search stored AST nodes (calls, new, string, regex, throw, await) by pattern',
  queryOpts: true,
  options: [
    ['-k, --kind <kind>', 'Filter by AST node kind (call, new, string, regex, throw, await)'],
    ['-f, --file <path>', 'Scope to file (partial match)'],
  ],
  async execute([pattern], opts, ctx) {
    const { AST_NODE_KINDS, astQuery } = await import('../../ast.js');
    if (opts.kind && !AST_NODE_KINDS.includes(opts.kind)) {
      console.error(`Invalid AST kind "${opts.kind}". Valid: ${AST_NODE_KINDS.join(', ')}`);
      process.exit(1);
    }
    astQuery(pattern, opts.db, {
      kind: opts.kind,
      file: opts.file,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      ndjson: opts.ndjson,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
    });
  },
};
