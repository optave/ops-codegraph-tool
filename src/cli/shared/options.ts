import type { Command } from 'commander';
import { loadConfig } from '../../infrastructure/config.js';
import type { CommandOpts } from '../types.js';

const config = loadConfig(process.cwd());

/**
 * Attach the common query options shared by most analysis commands.
 */
export function applyQueryOpts(cmd: Command): Command {
  return cmd
    .option('-d, --db <path>', 'Path to graph.db')
    .option('-T, --no-tests', 'Exclude test/spec files from results')
    .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
    .option('-j, --json', 'Output as JSON')
    .option('--limit <number>', 'Max results to return')
    .option('--offset <number>', 'Skip N results (default: 0)')
    .option('--ndjson', 'Newline-delimited JSON output')
    .option('--table', 'Output as aligned table')
    .option('--csv', 'Output as CSV');
}

/**
 * Resolve the effective noTests value: CLI flag > config > false.
 * Commander sets opts.tests to false when --no-tests is passed.
 * When --include-tests is passed, always return false (include tests).
 * Otherwise, fall back to config.query.excludeTests.
 */
export function resolveNoTests(opts: CommandOpts): boolean {
  if (opts.includeTests) return false;
  if (opts.tests === false) return true;
  return config.query?.excludeTests || false;
}

/**
 * Extract the common query option fields shared by most analysis commands.
 *
 * Spreads cleanly into per-command option objects:
 *   `{ ...resolveQueryOpts(opts), depth: parseInt(opts.depth, 10) }`
 */
export function resolveQueryOpts(opts: CommandOpts): CommandOpts {
  return {
    noTests: resolveNoTests(opts),
    json: opts.json,
    ndjson: opts.ndjson,
    table: opts.table,
    csv: opts.csv,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { config };
