import { AnalysisError } from '../../shared/errors.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
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
    const { analyzeCoChanges, coChangeData, coChangeTopData } = await import(
      '../../features/cochange.js'
    );
    const { formatCoChange, formatCoChangeTop } = await import('../../presentation/cochange.js');

    if (opts.analyze) {
      const coChangeConfig = ctx.config.coChange;
      const result = analyzeCoChanges(opts.db, {
        since: opts.since || coChangeConfig?.since,
        minSupport: opts.minSupport
          ? parseInt(opts.minSupport as string, 10)
          : coChangeConfig?.minSupport,
        maxFilesPerCommit: coChangeConfig?.maxFilesPerCommit,
        full: opts.full,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if ('error' in result) {
        throw new AnalysisError((result as { error: string }).error);
      } else {
        console.log(
          `\nCo-change analysis complete: ${result.pairsFound} pairs from ${result.commitsScanned} commits (since: ${result.since})\n`,
        );
      }
      return;
    }

    const coChangeConfig = ctx.config.coChange;
    const queryOpts = {
      limit: parseInt(opts.limit as string, 10),
      offset: opts.offset ? parseInt(opts.offset as string, 10) : undefined,
      minJaccard: opts.minJaccard
        ? parseFloat(opts.minJaccard as string)
        : (coChangeConfig?.minJaccard as number | undefined),
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
