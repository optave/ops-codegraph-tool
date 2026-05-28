import { cfgData, cfgToDOT, cfgToMermaid } from '../features/cfg.js';
import { outputResult } from '../infrastructure/result-formatter.js';

type CfgData = ReturnType<typeof cfgData>;

interface CfgCliOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  file?: string;
  kind?: string;
  format?: string;
  limit?: number;
  offset?: number;
}

interface CfgBlock {
  index: number;
  type: string;
  label?: string;
  startLine?: number;
  endLine?: number;
}

interface CfgEdge {
  source: number;
  target: number;
  kind: string;
}

interface CfgResultEntry {
  kind: string;
  name: string;
  file: string;
  line: number;
  summary: { blockCount: number; edgeCount: number };
  blocks: CfgBlock[];
  edges: CfgEdge[];
}

function renderBlockLocation(b: CfgBlock): string {
  if (!b.startLine) return '';
  const endSuffix = b.endLine && b.endLine !== b.startLine ? `-${b.endLine}` : '';
  return ` L${b.startLine}${endSuffix}`;
}

function printCfgBlocks(blocks: CfgBlock[]): void {
  if (blocks.length === 0) return;
  console.log('\n  Blocks:');
  for (const b of blocks) {
    const label = b.label ? ` (${b.label})` : '';
    console.log(`    [${b.index}] ${b.type}${label}${renderBlockLocation(b)}`);
  }
}

function printCfgEdges(edges: CfgEdge[]): void {
  if (edges.length === 0) return;
  console.log('\n  Edges:');
  for (const e of edges) {
    console.log(`    B${e.source} → B${e.target}  [${e.kind}]`);
  }
}

function printCfgEntry(r: CfgResultEntry): void {
  console.log(`\n${r.kind} ${r.name}  (${r.file}:${r.line})`);
  console.log('─'.repeat(60));
  console.log(`  Blocks: ${r.summary.blockCount}  Edges: ${r.summary.edgeCount}`);
  printCfgBlocks(r.blocks);
  printCfgEdges(r.edges);
}

function tryRenderGraphFormat(format: string, data: CfgData): boolean {
  if (format === 'dot') {
    console.log(cfgToDOT(data));
    return true;
  }
  if (format === 'mermaid') {
    console.log(cfgToMermaid(data));
    return true;
  }
  return false;
}

export function cfg(name: string, customDbPath: string | undefined, opts: CfgCliOpts = {}): void {
  const data = cfgData(name, customDbPath, opts);

  if (outputResult(data, 'results', opts)) return;

  if (data.warning) {
    console.log(`⚠  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  if (tryRenderGraphFormat(opts.format || 'text', data)) return;

  for (const r of data.results as CfgResultEntry[]) {
    printCfgEntry(r);
  }
}
