export const command = {
  name: 'branch-compare <base> <target>',
  description: 'Compare code structure between two branches/refs',
  options: [
    ['--depth <n>', 'Max transitive caller depth', '3'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['-f, --format <format>', 'Output format: text, mermaid, json', 'text'],
  ],
  async execute([base, target], opts, ctx) {
    const { branchCompare } = await import('../../presentation/branch-compare.js');
    await branchCompare(base, target, {
      engine: ctx.program.opts().engine,
      depth: parseInt(opts.depth, 10),
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      format: opts.format,
    });
  },
};
