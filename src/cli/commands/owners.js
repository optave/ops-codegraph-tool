export const command = {
  name: 'owners [target]',
  description: 'Show CODEOWNERS mapping for files and functions',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--owner <owner>', 'Filter to a specific owner'],
    ['--boundary', 'Show cross-owner boundary edges'],
    ['-f, --file <path>', 'Scope to a specific file'],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
  ],
  async execute([target], opts, ctx) {
    const { owners } = await import('../../presentation/owners.js');
    owners(opts.db, {
      owner: opts.owner,
      boundary: opts.boundary,
      file: opts.file || target,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
    });
  },
};
