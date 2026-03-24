import fs from 'node:fs';
import path from 'node:path';
import { openGraph } from '../shared/open-graph.js';
import type { CommandDefinition } from '../types.js';

interface PlotConfig {
  layout?: { algorithm?: string; direction?: string };
  physics?: { enabled?: boolean; nodeDistance?: number };
  nodeColors?: Record<string, string>;
  roleColors?: Record<string, string>;
  colorBy?: string;
  edgeStyle?: { color?: string; smooth?: boolean };
  filter?: { kinds?: string[] | null; roles?: string[] | null; files?: string[] | null };
  title?: string;
  seedStrategy?: string;
  seedCount?: number;
  clusterBy?: string;
  sizeBy?: string;
  overlays?: { complexity?: boolean; risk?: boolean };
  riskThresholds?: { highBlastRadius?: number; lowMI?: number };
}

export const command: CommandDefinition = {
  name: 'plot',
  description: 'Generate an interactive HTML dependency graph viewer',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--functions', 'Function-level graph instead of file-level'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['--min-confidence <score>', 'Minimum edge confidence threshold (default: 0.5)', '0.5'],
    ['-o, --output <file>', 'Write HTML to file'],
    ['-c, --config <path>', 'Path to .plotDotCfg config file'],
    ['--no-open', 'Do not open in browser'],
    ['--cluster <mode>', 'Cluster nodes: none | community | directory'],
    ['--overlay <list>', 'Comma-separated overlays: complexity,risk'],
    ['--seed <strategy>', 'Seed strategy: all | top-fanin | entry'],
    ['--seed-count <n>', 'Number of seed nodes (default: 30)'],
    ['--size-by <metric>', 'Size nodes by: uniform | fan-in | fan-out | complexity'],
    ['--color-by <mode>', 'Color nodes by: kind | role | community | complexity'],
  ],
  async execute(_args, opts, ctx) {
    const { generatePlotHTML, loadPlotConfig } = await import('../../features/graph-enrichment.js');
    const os = await import('node:os');
    const { db, close } = openGraph(opts as { db?: string });

    let plotCfg: PlotConfig;
    let html: string;
    try {
      if (opts.config) {
        try {
          plotCfg = JSON.parse(fs.readFileSync(opts.config as string, 'utf-8')) as PlotConfig;
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`Failed to load config: ${message}`);
          process.exitCode = 1;
          return;
        }
      } else {
        plotCfg = loadPlotConfig(process.cwd()) as PlotConfig;
      }

      if (opts.cluster) plotCfg.clusterBy = opts.cluster;
      if (opts.colorBy) plotCfg.colorBy = opts.colorBy;
      if (opts.sizeBy) plotCfg.sizeBy = opts.sizeBy;
      if (opts.seed) plotCfg.seedStrategy = opts.seed;
      if (opts.seedCount) plotCfg.seedCount = parseInt(opts.seedCount as string, 10);
      if (opts.overlay) {
        const parts = (opts.overlay as string).split(',').map((s) => s.trim());
        if (!plotCfg.overlays) plotCfg.overlays = {};
        if (parts.includes('complexity')) plotCfg.overlays.complexity = true;
        if (parts.includes('risk')) plotCfg.overlays.risk = true;
      }

      html = generatePlotHTML(db, {
        fileLevel: !opts.functions,
        noTests: ctx.resolveNoTests(opts),
        minConfidence: parseFloat(opts.minConfidence as string),
        config: plotCfg,
      });
    } finally {
      close();
    }

    if (!html) {
      console.error('generatePlotHTML returned no output');
      process.exitCode = 1;
      return;
    }

    const outPath =
      (opts.output as string) || path.join(os.tmpdir(), `codegraph-plot-${Date.now()}.html`);
    fs.writeFileSync(outPath, html, 'utf-8');
    console.log(`Plot written to ${outPath}`);

    if (opts.open !== false) {
      const { execFile } = await import('node:child_process');
      const args: [string, string[]] =
        process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', outPath]]
          : process.platform === 'darwin'
            ? ['open', [outPath]]
            : ['xdg-open', [outPath]];
      execFile(args[0], args[1], (err) => {
        if (err) console.error('Could not open browser:', err.message);
      });
    }
  },
};
