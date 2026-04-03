import { dataflowData, dataflowImpactData } from '../features/dataflow.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface DataflowCliOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  file?: string;
  kind?: string;
  impact?: boolean;
  depth?: string | number;
  limit?: number;
  offset?: number;
}

interface DataflowFlow {
  target?: string;
  source?: string;
  file: string;
  line: number;
  paramIndex: number;
  confidence: number;
}

interface DataflowReturn {
  consumer?: string;
  producer?: string;
  file: string;
  line: number;
  expression: string;
}

interface DataflowMutation {
  source?: string;
  expression: string;
  line: number;
}

interface DataflowResultEntry {
  kind: string;
  name: string;
  file: string;
  line: number;
  flowsTo: DataflowFlow[];
  flowsFrom: DataflowFlow[];
  returns: DataflowReturn[];
  returnedBy: DataflowReturn[];
  mutates: DataflowMutation[];
  mutatedBy: DataflowMutation[];
}

interface DataflowImpactEntry {
  kind: string;
  name: string;
  file: string;
  line: number;
  totalAffected: number;
  levels: Record<string, Array<{ name: string; file: string; line: number }>>;
}

function printDataflowFlows(r: DataflowResultEntry): void {
  if (r.flowsTo.length > 0) {
    console.log('\n  Data flows TO:');
    for (const f of r.flowsTo) {
      const conf = f.confidence < 1.0 ? ` [${(f.confidence * 100).toFixed(0)}%]` : '';
      console.log(`    \u2192 ${f.target} (${f.file}:${f.line}) arg[${f.paramIndex}]${conf}`);
    }
  }
  if (r.flowsFrom.length > 0) {
    console.log('\n  Data flows FROM:');
    for (const f of r.flowsFrom) {
      const conf = f.confidence < 1.0 ? ` [${(f.confidence * 100).toFixed(0)}%]` : '';
      console.log(`    \u2190 ${f.source} (${f.file}:${f.line}) arg[${f.paramIndex}]${conf}`);
    }
  }
}

function printDataflowReturns(r: DataflowResultEntry): void {
  if (r.returns.length > 0) {
    console.log('\n  Return value consumed by:');
    for (const c of r.returns) {
      console.log(`    \u2192 ${c.consumer} (${c.file}:${c.line})  ${c.expression}`);
    }
  }
  if (r.returnedBy.length > 0) {
    console.log('\n  Uses return value of:');
    for (const p of r.returnedBy) {
      console.log(`    \u2190 ${p.producer} (${p.file}:${p.line})  ${p.expression}`);
    }
  }
}

function printDataflowMutations(r: DataflowResultEntry): void {
  if (r.mutates.length > 0) {
    console.log('\n  Mutates:');
    for (const m of r.mutates) {
      console.log(`    \u270E ${m.expression}  (line ${m.line})`);
    }
  }
  if (r.mutatedBy.length > 0) {
    console.log('\n  Mutated by:');
    for (const m of r.mutatedBy) {
      console.log(`    \u270E ${m.source} \u2014 ${m.expression}  (line ${m.line})`);
    }
  }
}

export function dataflow(
  name: string,
  customDbPath: string | undefined,
  opts: DataflowCliOpts = {},
): void {
  if (opts.impact) {
    dataflowImpact(name, customDbPath, opts);
    return;
  }

  const data = dataflowData(name, customDbPath, opts) as {
    warning?: string;
    results: DataflowResultEntry[];
  };

  if (outputResult(data, 'results', opts)) return;

  if (data.warning) {
    console.log(`\u26A0  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${r.kind} ${r.name}  (${r.file}:${r.line})`);
    console.log('\u2500'.repeat(60));
    printDataflowFlows(r);
    printDataflowReturns(r);
    printDataflowMutations(r);
  }
}

function dataflowImpact(
  name: string,
  customDbPath: string | undefined,
  opts: DataflowCliOpts = {},
): void {
  const data = dataflowImpactData(name, customDbPath, {
    noTests: opts.noTests,
    depth: opts.depth ? Number(opts.depth) : 5,
    file: opts.file,
    kind: opts.kind,
    limit: opts.limit,
    offset: opts.offset,
  }) as { warning?: string; results: DataflowImpactEntry[] };

  if (outputResult(data, 'results', opts)) return;

  if (data.warning) {
    console.log(`\u26A0  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  for (const r of data.results) {
    console.log(
      `\n${r.kind} ${r.name}  (${r.file}:${r.line})  \u2014 ${r.totalAffected} data-dependent consumer${r.totalAffected !== 1 ? 's' : ''}`,
    );
    for (const [level, items] of Object.entries(r.levels)) {
      console.log(`  Level ${level}:`);
      for (const item of items) {
        console.log(`    ${item.name} (${item.file}:${item.line})`);
      }
    }
  }
}
