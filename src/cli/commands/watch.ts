import path from 'node:path';
import { watchProject } from '../../domain/graph/watcher.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'watch [dir]',
  description: 'Watch project for file changes and incrementally update the graph',
  options: [
    ['--poll', 'Use stat-based polling (default on Windows to avoid ReFS/Dev Drive crashes)'],
    ['--native', 'Force native OS file watchers instead of polling'],
    ['--poll-interval <ms>', 'Polling interval in milliseconds (default: 2000)', '2000'],
  ],
  async execute([dir], opts, ctx) {
    const root = path.resolve(dir || '.');
    const engine = ctx.program.opts().engine;
    // Explicit --poll or --native wins; otherwise let watcher auto-detect by platform
    const poll = opts.poll ? true : opts.native ? false : undefined;
    await watchProject(root, {
      engine,
      poll,
      pollInterval: opts.pollInterval ? Number(opts.pollInterval) : undefined,
    });
  },
};
