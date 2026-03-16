import { AnalysisError } from '../../shared/errors.js';

export const command = {
  name: 'co-change [file]',
  description:
    'Analyze git history for files that change together. Use --analyze to scan, or query existing data.',
  options: [
    ['--analyze', 'Scan git history and populate co-change data'],
    ['--since <date>', 'Git date for history window (default: "1 year ago")'],
    ['--min-support <n>', 'Minimum co-occurrence count (default: 3)'],
    ['--min-jaccard <n>', 'Minimum Jaccard similarity 0-1 (default: 0.3)'],
    ['--full', 'Force full re-scan (ignore incremental state)'],
    ['-n, --limit <n>', 'Max results', '20'],
    ['-d, --db <path>', 'Path to graph.db'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
  ],
  async execute([file], opts, ctx) {
    const { analyzeCoChanges, coChangeData, coChangeTopData } = await import('../../cochange.js');
    const { formatCoChange, formatCoChangeTop } = await import('../../presentation/cochange.js');

    if (opts.analyze) {
      const result = analyzeCoChanges(opts.db, {
        since: opts.since || ctx.config.coChange?.since,
        minSupport: opts.minSupport
          ? parseInt(opts.minSupport, 10)
          : ctx.config.coChange?.minSupport,
        maxFilesPerCommit: ctx.config.coChange?.maxFilesPerCommit,
        full: opts.full,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.error) {
        throw new AnalysisError(result.error);
      } else {
        console.log(
          `\nCo-change analysis complete: ${result.pairsFound} pairs from ${result.commitsScanned} commits (since: ${result.since})\n`,
        );
      }
      return;
    }

    const queryOpts = {
      limit: parseInt(opts.limit, 10),
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      minJaccard: opts.minJaccard ? parseFloat(opts.minJaccard) : ctx.config.coChange?.minJaccard,
      noTests: ctx.resolveNoTests(opts),
    };

    if (file) {
      const data = coChangeData(file, opts.db, queryOpts);
      if (!ctx.outputResult(data, 'partners', opts)) {
        console.log(formatCoChange(data));
      }
    } else {
      const data = coChangeTopData(opts.db, queryOpts);
      if (!ctx.outputResult(data, 'pairs', opts)) {
        console.log(formatCoChangeTop(data));
      }
    }
  },
};
