import { DEFAULT_MODEL, MODELS } from '../../domain/search/index.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'models',
  description: 'List available embedding models',
  execute(_args, _opts, ctx) {
    const embeddingsConfig = ctx.config.embeddings;
    const defaultModel = (embeddingsConfig?.model as string) || DEFAULT_MODEL;
    console.log('\nAvailable embedding models:\n');

    interface ModelEntry {
      dim: number;
      desc: string;
      contextWindow?: number;
    }

    for (const [key, cfg] of Object.entries(MODELS)) {
      const def = key === defaultModel ? ' (default)' : '';
      const modelCfg = cfg as ModelEntry;
      const ctxWindow = modelCfg.contextWindow ? `${modelCfg.contextWindow} ctx` : '';
      console.log(
        `  ${key.padEnd(12)} ${String(modelCfg.dim).padStart(4)}d  ${ctxWindow.padEnd(9)} ${modelCfg.desc}${def}`,
      );
    }
    console.log('\nUsage: codegraph embed --model <name> --strategy <structured|source>');
    console.log('       codegraph search "query" --model <name>\n');
  },
};
