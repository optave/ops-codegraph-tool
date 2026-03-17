export const command = {
  name: 'structure [dir]',
  description:
    'Show project directory structure with hierarchy, cohesion scores, and per-file metrics',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--depth <n>', 'Max directory depth'],
    ['--sort <metric>', 'Sort by: cohesion | fan-in | fan-out | density | files', 'files'],
    ['--full', 'Show all files without limit'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['--limit <number>', 'Max results to return'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
  ],
  async execute([dir], opts, ctx) {
    const { structureData, formatStructure } = await import('../../presentation/structure.js');
    const qOpts = ctx.resolveQueryOpts(opts);
    const data = structureData(opts.db, {
      directory: dir,
      depth: opts.depth ? parseInt(opts.depth, 10) : undefined,
      sort: opts.sort,
      full: opts.full,
      noTests: qOpts.noTests,
      limit: qOpts.limit,
      offset: qOpts.offset,
    });
    if (!ctx.outputResult(data, 'directories', opts)) {
      console.log(formatStructure(data));
    }
  },
};
