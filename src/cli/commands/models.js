import { DEFAULT_MODEL, MODELS } from '../../embedder.js';

export const command = {
  name: 'models',
  description: 'List available embedding models',
  execute(_args, _opts, ctx) {
    const defaultModel = ctx.config.embeddings?.model || DEFAULT_MODEL;
    console.log('\nAvailable embedding models:\n');
    for (const [key, cfg] of Object.entries(MODELS)) {
      const def = key === defaultModel ? ' (default)' : '';
      const ctxWindow = cfg.contextWindow ? `${cfg.contextWindow} ctx` : '';
      console.log(
        `  ${key.padEnd(12)} ${String(cfg.dim).padStart(4)}d  ${ctxWindow.padEnd(9)} ${cfg.desc}${def}`,
      );
    }
    console.log('\nUsage: codegraph embed --model <name> --strategy <structured|source>');
    console.log('       codegraph search "query" --model <name>\n');
  },
};
