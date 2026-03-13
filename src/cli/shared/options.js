import { loadConfig } from '../../config.js';

const config = loadConfig(process.cwd());

/**
 * Attach the common query options shared by most analysis commands.
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
export function applyQueryOpts(cmd) {
  return cmd
    .option('-d, --db <path>', 'Path to graph.db')
    .option('-T, --no-tests', 'Exclude test/spec files from results')
    .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
    .option('-j, --json', 'Output as JSON')
    .option('--limit <number>', 'Max results to return')
    .option('--offset <number>', 'Skip N results (default: 0)')
    .option('--ndjson', 'Newline-delimited JSON output');
}

/**
 * Resolve the effective noTests value: CLI flag > config > false.
 * Commander sets opts.tests to false when --no-tests is passed.
 * When --include-tests is passed, always return false (include tests).
 * Otherwise, fall back to config.query.excludeTests.
 */
export function resolveNoTests(opts) {
  if (opts.includeTests) return false;
  if (opts.tests === false) return true;
  return config.query?.excludeTests || false;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { config };
