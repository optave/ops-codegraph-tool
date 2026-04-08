import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
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
    ['--modules', 'Show module boundaries (directories with high cohesion)'],
    ['--threshold <number>', 'Cohesion threshold for --modules (default: 0.3)'],
  ],
  async execute([dir], opts, ctx) {
    const { structureData, formatStructure, moduleBoundariesData, formatModuleBoundaries } =
      await import('../../presentation/structure.js');

    if (opts.modules) {
      const data = moduleBoundariesData(opts.db, {
        threshold: opts.threshold ? parseFloat(opts.threshold as string) : undefined,
      });
      if (!ctx.outputResult(data, 'modules', opts)) {
        console.log(formatModuleBoundaries(data));
      }
      return;
    }

    const qOpts = ctx.resolveQueryOpts(opts);
    const data = structureData(opts.db, {
      directory: dir,
      depth: opts.depth ? parseInt(opts.depth as string, 10) : undefined,
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
