import { EVERY_SYMBOL_KIND, VALID_ROLES } from '../../queries.js';

export const command = {
  name: 'triage',
  description:
    'Ranked audit queue by composite risk score (connectivity + complexity + churn + role)',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-n, --limit <number>', 'Max results to return', '20'],
    [
      '--level <level>',
      'Granularity: function (default) | file | directory. File/directory level shows hotspots',
      'function',
    ],
    [
      '--sort <metric>',
      'Sort metric: risk | complexity | churn | fan-in | mi (function level); fan-in | fan-out | density | coupling (file/directory level)',
      'risk',
    ],
    ['--min-score <score>', 'Only show symbols with risk score >= threshold'],
    ['--role <role>', 'Filter by role (entry, core, utility, adapter, leaf, dead)'],
    ['-f, --file <path>', 'Scope to a specific file (partial match)'],
    ['-k, --kind <kind>', 'Filter by symbol kind (function, method, class)'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
    ['--weights <json>', 'Custom weights JSON (e.g. \'{"fanIn":1,"complexity":0}\')'],
  ],
  async execute(_args, opts, ctx) {
    if (opts.level === 'file' || opts.level === 'directory') {
      const { hotspotsData, formatHotspots } = await import('../../commands/structure.js');
      const metric = opts.sort === 'risk' ? 'fan-in' : opts.sort;
      const data = hotspotsData(opts.db, {
        metric,
        level: opts.level,
        limit: parseInt(opts.limit, 10),
        offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
        noTests: ctx.resolveNoTests(opts),
      });
      if (!ctx.outputResult(data, 'hotspots', opts)) {
        console.log(formatHotspots(data));
      }
      return;
    }

    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`);
      process.exit(1);
    }
    if (opts.role && !VALID_ROLES.includes(opts.role)) {
      console.error(`Invalid role "${opts.role}". Valid: ${VALID_ROLES.join(', ')}`);
      process.exit(1);
    }
    let weights;
    if (opts.weights) {
      try {
        weights = JSON.parse(opts.weights);
      } catch {
        console.error('Invalid --weights JSON');
        process.exit(1);
      }
    }
    const { triage } = await import('../../commands/triage.js');
    triage(opts.db, {
      limit: parseInt(opts.limit, 10),
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      sort: opts.sort,
      minScore: opts.minScore,
      role: opts.role,
      file: opts.file,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      ndjson: opts.ndjson,
      weights,
    });
  },
};
