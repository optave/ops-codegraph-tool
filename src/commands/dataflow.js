import { dataflowData, dataflowImpactData } from '../dataflow.js';
import { outputResult } from '../infrastructure/result-formatter.js';

/**
 * CLI display for dataflow command.
 */
export function dataflow(name, customDbPath, opts = {}) {
  if (opts.impact) {
    return dataflowImpact(name, customDbPath, opts);
  }

  const data = dataflowData(name, customDbPath, opts);

  if (outputResult(data, 'results', opts)) return;

  if (data.warning) {
    console.log(`⚠  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${r.kind} ${r.name}  (${r.file}:${r.line})`);
    console.log('─'.repeat(60));

    if (r.flowsTo.length > 0) {
      console.log('\n  Data flows TO:');
      for (const f of r.flowsTo) {
        const conf = f.confidence < 1.0 ? ` [${(f.confidence * 100).toFixed(0)}%]` : '';
        console.log(`    → ${f.target} (${f.file}:${f.line}) arg[${f.paramIndex}]${conf}`);
      }
    }

    if (r.flowsFrom.length > 0) {
      console.log('\n  Data flows FROM:');
      for (const f of r.flowsFrom) {
        const conf = f.confidence < 1.0 ? ` [${(f.confidence * 100).toFixed(0)}%]` : '';
        console.log(`    ← ${f.source} (${f.file}:${f.line}) arg[${f.paramIndex}]${conf}`);
      }
    }

    if (r.returns.length > 0) {
      console.log('\n  Return value consumed by:');
      for (const c of r.returns) {
        console.log(`    → ${c.consumer} (${c.file}:${c.line})  ${c.expression}`);
      }
    }

    if (r.returnedBy.length > 0) {
      console.log('\n  Uses return value of:');
      for (const p of r.returnedBy) {
        console.log(`    ← ${p.producer} (${p.file}:${p.line})  ${p.expression}`);
      }
    }

    if (r.mutates.length > 0) {
      console.log('\n  Mutates:');
      for (const m of r.mutates) {
        console.log(`    ✎ ${m.expression}  (line ${m.line})`);
      }
    }

    if (r.mutatedBy.length > 0) {
      console.log('\n  Mutated by:');
      for (const m of r.mutatedBy) {
        console.log(`    ✎ ${m.source} — ${m.expression}  (line ${m.line})`);
      }
    }
  }
}

/**
 * CLI display for dataflow --impact.
 */
function dataflowImpact(name, customDbPath, opts = {}) {
  const data = dataflowImpactData(name, customDbPath, {
    noTests: opts.noTests,
    depth: opts.depth ? Number(opts.depth) : 5,
    file: opts.file,
    kind: opts.kind,
    limit: opts.limit,
    offset: opts.offset,
  });

  if (outputResult(data, 'results', opts)) return;

  if (data.warning) {
    console.log(`⚠  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  for (const r of data.results) {
    console.log(
      `\n${r.kind} ${r.name}  (${r.file}:${r.line})  — ${r.totalAffected} data-dependent consumer${r.totalAffected !== 1 ? 's' : ''}`,
    );
    for (const [level, items] of Object.entries(r.levels)) {
      console.log(`  Level ${level}:`);
      for (const item of items) {
        console.log(`    ${item.name} (${item.file}:${item.line})`);
      }
    }
  }
}
