import { flowData, listEntryPointsData } from '../flow.js';
import { outputResult } from '../infrastructure/result-formatter.js';
import { kindIcon } from '../queries.js';

/**
 * CLI formatter — text or JSON output.
 */
export function flow(name, dbPath, opts = {}) {
  if (opts.list) {
    const data = listEntryPointsData(dbPath, {
      noTests: opts.noTests,
      limit: opts.limit,
      offset: opts.offset,
    });
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
    return;
  }

  const data = flowData(name, dbPath, opts);
  if (outputResult(data, 'steps', opts)) return;

  if (!data.entry) {
    console.log(`No matching entry point or function found for "${name}".`);
    return;
  }

  const e = data.entry;
  const typeTag = e.type !== 'exported' ? ` (${e.type})` : '';
  console.log(`\nFlow from: [${kindIcon(e.kind)}] ${e.name}${typeTag}  ${e.file}:${e.line}`);
  console.log(
    `Depth: ${data.depth}  Reached: ${data.totalReached} nodes  Leaves: ${data.leaves.length}`,
  );
  if (data.truncated) {
    console.log(`  (truncated at depth ${data.depth})`);
  }
  console.log();

  if (data.steps.length === 0) {
    console.log('  (leaf node — no callees)');
    return;
  }

  for (const step of data.steps) {
    console.log(`  depth ${step.depth}:`);
    for (const n of step.nodes) {
      const isLeaf = data.leaves.some((l) => l.name === n.name && l.file === n.file);
      const leafTag = isLeaf ? ' [leaf]' : '';
      console.log(`    [${kindIcon(n.kind)}] ${n.name}  ${n.file}:${n.line}${leafTag}`);
    }
  }

  if (data.cycles.length > 0) {
    console.log('\n  Cycles detected:');
    for (const c of data.cycles) {
      console.log(`    ${c.from} -> ${c.to} (at depth ${c.depth})`);
    }
  }
}
