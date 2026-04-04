import { diffImpact } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
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
    ['-j, --json', 'Output as JSON (shorthand for -f json)'],
    ['-f, --format <format>', 'Output format: text, mermaid, json', 'text'],
    ['--no-implementations', 'Exclude interface/trait implementors from blast radius'],
  ],
  execute([ref], opts, ctx) {
    diffImpact(opts.db, {
      ref,
      staged: opts.staged,
      depth: parseInt(opts.depth as string, 10),
      format: opts.json ? 'json' : opts.format,
      includeImplementors: opts.implementations !== false,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
