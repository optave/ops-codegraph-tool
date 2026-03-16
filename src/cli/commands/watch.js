import path from 'node:path';
import { watchProject } from '../../domain/graph/watcher.js';

export const command = {
  name: 'watch [dir]',
  description: 'Watch project for file changes and incrementally update the graph',
  async execute([dir], _opts, ctx) {
    const root = path.resolve(dir || '.');
    const engine = ctx.program.opts().engine;
    await watchProject(root, { engine });
  },
};
