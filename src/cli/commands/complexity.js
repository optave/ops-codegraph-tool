import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';

export const command = {
  name: 'complexity [target]',
  description: 'Show per-function complexity metrics (cognitive, cyclomatic, nesting depth, MI)',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-n, --limit <number>', 'Max results', '20'],
    [
      '--sort <metric>',
      'Sort by: cognitive | cyclomatic | nesting | mi | volume | effort | bugs | loc',
      'cognitive',
    ],
    ['--above-threshold', 'Only functions exceeding warn thresholds'],
    ['--health', 'Show health metrics (Halstead, MI) columns'],
    ['-f, --file <path>', 'Scope to file (partial match)'],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
  ],
  validate([_target], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([target], opts, ctx) {
    const { complexity } = await import('../../presentation/complexity.js');
    complexity(opts.db, {
      target,
      limit: parseInt(opts.limit, 10),
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      sort: opts.sort,
      aboveThreshold: opts.aboveThreshold,
      health: opts.health,
      file: opts.file,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      ndjson: opts.ndjson,
    });
  },
};
