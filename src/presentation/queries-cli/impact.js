import {
  diffImpactData,
  diffImpactMermaid,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  kindIcon,
} from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

export function fileDeps(file, customDbPath, opts = {}) {
  const data = fileDepsData(file, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n# ${r.file}\n`);
    console.log(`  -> Imports (${r.imports.length}):`);
    for (const i of r.imports) {
      const typeTag = i.typeOnly ? ' (type-only)' : '';
      console.log(`    -> ${i.file}${typeTag}`);
    }
    console.log(`\n  <- Imported by (${r.importedBy.length}):`);
    for (const i of r.importedBy) console.log(`    <- ${i.file}`);
    if (r.definitions.length > 0) {
      console.log(`\n  Definitions (${r.definitions.length}):`);
      for (const d of r.definitions.slice(0, 30))
        console.log(`    ${kindIcon(d.kind)} ${d.name} :${d.line}`);
      if (r.definitions.length > 30) console.log(`    ... and ${r.definitions.length - 30} more`);
    }
    console.log();
  }
}

export function fnDeps(name, customDbPath, opts = {}) {
  const data = fnDepsData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name} (${r.kind}) -- ${r.file}:${r.line}\n`);
    if (r.callees.length > 0) {
      console.log(`  -> Calls (${r.callees.length}):`);
      for (const c of r.callees)
        console.log(`    -> ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
    }
    if (r.callers.length > 0) {
      console.log(`\n  <- Called by (${r.callers.length}):`);
      for (const c of r.callers) {
        const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
        console.log(`    <- ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
      }
    }
    for (const [d, fns] of Object.entries(r.transitiveCallers)) {
      console.log(
        `\n  ${'<-'.repeat(parseInt(d, 10))} Transitive callers (depth ${d}, ${fns.length}):`,
      );
      for (const n of fns.slice(0, 20))
        console.log(
          `    ${'  '.repeat(parseInt(d, 10) - 1)}<- ${kindIcon(n.kind)} ${n.name}  ${n.file}:${n.line}`,
        );
      if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
    }
    if (r.callees.length === 0 && r.callers.length === 0) {
      console.log(`  (no call edges found -- may be invoked dynamically or via re-exports)`);
    }
    console.log();
  }
}

export function impactAnalysis(file, customDbPath, opts = {}) {
  const data = impactAnalysisData(file, customDbPath, opts);
  if (outputResult(data, 'sources', opts)) return;

  if (data.sources.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  console.log(`\nImpact analysis for files matching "${file}":\n`);
  for (const s of data.sources) console.log(`  # ${s} (source)`);

  const levels = data.levels;
  if (Object.keys(levels).length === 0) {
    console.log(`  No dependents found.`);
  } else {
    for (const level of Object.keys(levels).sort((a, b) => a - b)) {
      const nodes = levels[level];
      console.log(
        `\n  ${'--'.repeat(parseInt(level, 10))} Level ${level} (${nodes.length} files):`,
      );
      for (const n of nodes.slice(0, 30))
        console.log(`    ${'  '.repeat(parseInt(level, 10))}^ ${n.file}`);
      if (nodes.length > 30) console.log(`    ... and ${nodes.length - 30} more`);
    }
  }
  console.log(`\n  Total: ${data.totalDependents} files transitively depend on "${file}"\n`);
}

export function fnImpact(name, customDbPath, opts = {}) {
  const data = fnImpactData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\nFunction impact: ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}\n`);
    if (Object.keys(r.levels).length === 0) {
      console.log(`  No callers found.`);
    } else {
      for (const [level, fns] of Object.entries(r.levels).sort((a, b) => a[0] - b[0])) {
        const l = parseInt(level, 10);
        console.log(`  ${'--'.repeat(l)} Level ${level} (${fns.length} functions):`);
        for (const f of fns.slice(0, 20))
          console.log(`    ${'  '.repeat(l)}^ ${kindIcon(f.kind)} ${f.name}  ${f.file}:${f.line}`);
        if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
      }
    }
    console.log(`\n  Total: ${r.totalDependents} functions transitively depend on ${r.name}\n`);
  }
}

export function diffImpact(customDbPath, opts = {}) {
  if (opts.format === 'mermaid') {
    console.log(diffImpactMermaid(customDbPath, opts));
    return;
  }
  const data = diffImpactData(customDbPath, opts);
  if (opts.format === 'json') opts = { ...opts, json: true };
  if (outputResult(data, 'affectedFunctions', opts)) return;

  if (data.error) {
    console.log(data.error);
    return;
  }
  if (data.changedFiles === 0) {
    console.log('No changes detected.');
    return;
  }
  if (data.affectedFunctions.length === 0) {
    console.log(
      '  No function-level changes detected (changes may be in imports, types, or config).',
    );
    return;
  }

  console.log(`\ndiff-impact: ${data.changedFiles} files changed\n`);
  console.log(`  ${data.affectedFunctions.length} functions changed:\n`);
  for (const fn of data.affectedFunctions) {
    console.log(`  ${kindIcon(fn.kind)} ${fn.name} -- ${fn.file}:${fn.line}`);
    if (fn.transitiveCallers > 0) console.log(`    ^ ${fn.transitiveCallers} transitive callers`);
  }
  if (data.historicallyCoupled && data.historicallyCoupled.length > 0) {
    console.log('\n  Historically coupled (not in static graph):\n');
    for (const c of data.historicallyCoupled) {
      const pct = `${(c.jaccard * 100).toFixed(0)}%`;
      console.log(
        `    ${c.file}  <- coupled with ${c.coupledWith} (${pct}, ${c.commitCount} commits)`,
      );
    }
  }
  if (data.ownership) {
    console.log(`\n  Affected owners: ${data.ownership.affectedOwners.join(', ')}`);
    console.log(`  Suggested reviewers: ${data.ownership.suggestedReviewers.join(', ')}`);
  }
  if (data.boundaryViolations && data.boundaryViolations.length > 0) {
    console.log(`\n  Boundary violations (${data.boundaryViolationCount}):\n`);
    for (const v of data.boundaryViolations) {
      console.log(`    [${v.name}] ${v.file} -> ${v.targetFile}`);
      if (v.message) console.log(`      ${v.message}`);
    }
  }
  if (data.summary) {
    let summaryLine = `\n  Summary: ${data.summary.functionsChanged} functions changed -> ${data.summary.callersAffected} callers affected across ${data.summary.filesAffected} files`;
    if (data.summary.historicallyCoupledCount > 0) {
      summaryLine += `, ${data.summary.historicallyCoupledCount} historically coupled`;
    }
    if (data.summary.ownersAffected > 0) {
      summaryLine += `, ${data.summary.ownersAffected} owners affected`;
    }
    if (data.summary.boundaryViolationCount > 0) {
      summaryLine += `, ${data.summary.boundaryViolationCount} boundary violations`;
    }
    console.log(`${summaryLine}\n`);
  }
}
