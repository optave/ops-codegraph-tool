import { kindIcon } from '../domain/queries.js';
import { flowData, listEntryPointsData } from '../features/flow.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface FlowOpts {
  list?: boolean;
  noTests?: boolean;
  limit?: number;
  offset?: number;
  depth?: number;
  file?: string;
  kind?: string;
  json?: boolean;
  ndjson?: boolean;
  table?: boolean;
  csv?: boolean;
}

interface EntryPoint {
  kind: string;
  name: string;
  file: string;
  line: number;
}

interface FlowNode {
  kind: string;
  name: string;
  file: string;
  line: number;
}

interface FlowStep {
  depth: number;
  nodes: FlowNode[];
}

interface FlowCycle {
  from: string;
  to: string;
  depth: number;
}

interface FlowResult {
  entry?: { kind: string; name: string; type: string; file: string; line: number };
  depth: number;
  totalReached: number;
  leaves: Array<{ name: string; file: string }>;
  steps: FlowStep[];
  cycles: FlowCycle[];
  truncated?: boolean;
}

function runListEntryPoints(dbPath: string | undefined, opts: FlowOpts): void {
  const data = listEntryPointsData(dbPath, {
    noTests: opts.noTests,
    limit: opts.limit,
    offset: opts.offset,
  }) as { count: number; byType: Record<string, EntryPoint[]> };
  if (outputResult(data, 'entries', opts)) return;
  if (data.count === 0) {
    console.log('No entry points found. Run "codegraph build" first.');
    return;
  }
  console.log(`\nEntry points (${data.count} total):\n`);
  for (const [type, entries] of Object.entries(data.byType)) {
    console.log(`  ${type} (${entries.length}):`);
    for (const e of entries) {
      console.log(`    [${kindIcon(e.kind)}] ${e.name}  ${e.file}:${e.line}`);
    }
    console.log();
  }
}

function printFlowHeader(data: FlowResult): void {
  const e = data.entry;
  if (!e) return;
  const typeTag = e.type !== 'exported' ? ` (${e.type})` : '';
  console.log(`\nFlow from: [${kindIcon(e.kind)}] ${e.name}${typeTag}  ${e.file}:${e.line}`);
  console.log(
    `Depth: ${data.depth}  Reached: ${data.totalReached} nodes  Leaves: ${data.leaves.length}`,
  );
  if (data.truncated) {
    console.log(`  (truncated at depth ${data.depth})`);
  }
  console.log();
}

function isLeafNode(n: FlowNode, leaves: Array<{ name: string; file: string }>): boolean {
  return leaves.some((l) => l.name === n.name && l.file === n.file);
}

/** Returns true when the node is a leaf (no steps); caller should skip cycle output. */
function printFlowSteps(data: FlowResult): boolean {
  if (data.steps.length === 0) {
    console.log('  (leaf node — no callees)');
    return true;
  }
  for (const step of data.steps) {
    console.log(`  depth ${step.depth}:`);
    for (const n of step.nodes) {
      const leafTag = isLeafNode(n, data.leaves) ? ' [leaf]' : '';
      console.log(`    [${kindIcon(n.kind)}] ${n.name}  ${n.file}:${n.line}${leafTag}`);
    }
  }
  return false;
}

function printFlowCycles(cycles: FlowCycle[]): void {
  if (cycles.length === 0) return;
  console.log('\n  Cycles detected:');
  for (const c of cycles) {
    console.log(`    ${c.from} -> ${c.to} (at depth ${c.depth})`);
  }
}

export function flow(
  name: string | undefined,
  dbPath: string | undefined,
  opts: FlowOpts = {},
): void {
  if (opts.list) {
    runListEntryPoints(dbPath, opts);
    return;
  }

  if (!name) {
    console.log(
      'Please provide a function or entry-point name. Use --list to see available entry points.',
    );
    return;
  }

  const data = flowData(name, dbPath, opts) as unknown as FlowResult;
  if (outputResult(data, 'steps', opts)) return;

  if (!data.entry) {
    console.log(`No matching entry point or function found for "${name}".`);
    return;
  }

  printFlowHeader(data);
  const isLeaf = printFlowSteps(data);
  if (!isLeaf) {
    printFlowCycles(data.cycles);
  }
}
