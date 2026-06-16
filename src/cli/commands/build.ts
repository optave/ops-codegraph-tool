import path from 'node:path';
import { buildGraph } from '../../domain/graph/builder.js';
import type { EngineMode } from '../../types.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'build [dir]',
  description: 'Parse repo and build graph in .codegraph/graph.db',
  options: [
    ['-d, --db <path>', 'Path to graph.db (default: <dir>/.codegraph/graph.db)'],
    ['--no-incremental', 'Force full rebuild (ignore file hashes)'],
    ['--no-ast', 'Skip AST node extraction (calls, new, string, regex, throw, await)'],
    ['--no-complexity', 'Skip complexity metrics computation'],
    ['--no-dataflow', 'Skip data flow edge extraction'],
    ['--no-cfg', 'Skip control flow graph building'],
  ],
  async execute([dir], opts, ctx) {
    const root = path.resolve(dir || '.');
    const globalOpts = ctx.program.opts();
    const engine = globalOpts.engine;
    // Prompt for global-config consent on interactive TTY builds (§4.3).
    const promptForConsent = !process.env.CI && !!process.stdin.isTTY && !!process.stdout.isTTY;
    await buildGraph(root, {
      incremental: opts.incremental as boolean,
      ast: opts.ast as boolean,
      complexity: opts.complexity as boolean,
      engine: engine as EngineMode,
      dataflow: opts.dataflow as boolean,
      cfg: opts.cfg as boolean,
      dbPath: opts.db ? path.resolve(opts.db as string) : undefined,
      userConfig: globalOpts.userConfig as string | boolean | undefined,
      promptForConsent,
    });
  },
};
