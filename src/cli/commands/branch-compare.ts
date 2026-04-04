import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'branch-compare <base> <target>',
  description: 'Compare code structure between two branches/refs',
  options: [
    ['--depth <n>', 'Max transitive caller depth', '3'],
    ['-d, --db <path>', 'Path to graph.db'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['-f, --format <format>', 'Output format: text, mermaid, json', 'text'],
  ],
  async execute([base, target], opts, ctx) {
    const { branchCompare } = await import('../../presentation/branch-compare.js');
    const path = await import('node:path');
    const repoRoot = opts.db ? path.resolve(path.dirname(opts.db as string), '..') : undefined;
    await branchCompare(base!, target!, {
      engine: ctx.program.opts().engine,
      depth: parseInt(opts.depth as string, 10),
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      format: opts.format,
      repoRoot,
    });
  },
};
