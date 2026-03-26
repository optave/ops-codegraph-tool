import path from 'node:path';
import { buildGraph } from '../../domain/graph/builder.js';
import type { EngineMode } from '../../types.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
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
      incremental: opts.incremental as boolean,
      ast: opts.ast as boolean,
      complexity: opts.complexity as boolean,
      engine: engine as EngineMode,
      dataflow: opts.dataflow as boolean,
      cfg: opts.cfg as boolean,
    });
  },
};
