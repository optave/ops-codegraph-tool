import path from 'node:path';
import { buildGraph } from '../../builder.js';

export const command = {
  name: 'build [dir]',
  description: 'Parse repo and build graph in .codegraph/graph.db',
  options: [
    ['--no-incremental', 'Force full rebuild (ignore file hashes)'],
    ['--no-ast', 'Skip AST node extraction (calls, new, string, regex, throw, await)'],
    ['--no-complexity', 'Skip complexity metrics computation'],
    ['--no-dataflow', 'Skip data flow edge extraction'],
    ['--no-cfg', 'Skip control flow graph building'],
  ],
  async execute([dir], opts, ctx) {
    const root = path.resolve(dir || '.');
    const engine = ctx.program.opts().engine;
    await buildGraph(root, {
      incremental: opts.incremental,
      ast: opts.ast,
      complexity: opts.complexity,
      engine,
      dataflow: opts.dataflow,
      cfg: opts.cfg,
    });
  },
};
