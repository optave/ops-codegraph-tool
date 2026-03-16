import { diffImpact } from '../../queries-cli.js';

export const command = {
  name: 'diff-impact [ref]',
  description: 'Show impact of git changes (unstaged, staged, or vs a ref)',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['--limit <number>', 'Max results to return'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
    ['--staged', 'Analyze staged changes instead of unstaged'],
    ['--depth <n>', 'Max transitive caller depth', '3'],
    ['-f, --format <format>', 'Output format: text, mermaid, json', 'text'],
  ],
  execute([ref], opts, ctx) {
    diffImpact(opts.db, {
      ref,
      staged: opts.staged,
      depth: parseInt(opts.depth, 10),
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      format: opts.format,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  },
};
