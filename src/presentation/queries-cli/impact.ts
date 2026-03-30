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

interface SymbolRef {
  kind: string;
  name: string;
  file: string;
  line: number;
}

interface FileDepsImport {
  file: string;
  typeOnly?: boolean;
}

interface FileDepsResult {
  file: string;
  imports: FileDepsImport[];
  importedBy: { file: string }[];
  definitions: SymbolRef[];
}

interface FileDepsData {
  results: FileDepsResult[];
}

interface CallerRef extends SymbolRef {
  viaHierarchy?: string;
}

interface FnDepsResult extends SymbolRef {
  callees: SymbolRef[];
  callers: CallerRef[];
  transitiveCallers: Record<string, SymbolRef[]>;
}

interface FnDepsData {
  results: FnDepsResult[];
}

interface ImpactNode {
  file: string;
}

interface ImpactData {
  sources: string[];
  levels: Record<string, ImpactNode[]>;
  totalDependents: number;
}

interface FnImpactResult extends SymbolRef {
  levels: Record<string, SymbolRef[]>;
  totalDependents: number;
}

interface FnImpactData {
  results: FnImpactResult[];
}

interface AffectedFunction extends SymbolRef {
  transitiveCallers: number;
}

interface CoupledFile {
  file: string;
  coupledWith: string;
  jaccard: number;
  commitCount: number;
}

interface BoundaryViolation {
  name: string;
  file: string;
  targetFile: string;
  message?: string;
}

interface DiffSummary {
  functionsChanged: number;
  callersAffected: number;
  filesAffected: number;
  historicallyCoupledCount: number;
  ownersAffected: number;
  boundaryViolationCount: number;
}

interface DiffImpactData {
  error?: string;
  changedFiles: number;
  affectedFunctions: AffectedFunction[];
  historicallyCoupled?: CoupledFile[];
  ownership?: {
    affectedOwners: string[];
    suggestedReviewers: string[];
  };
  boundaryViolations?: BoundaryViolation[];
  boundaryViolationCount?: number;
  summary?: DiffSummary;
}

interface OutputOpts {
  json?: boolean;
  ndjson?: boolean;
  csv?: boolean;
  table?: boolean;
  noTests?: boolean;
  limit?: number;
  offset?: number;
  depth?: number;
  format?: string;
  staged?: boolean;
  ref?: string;
  file?: string;
  kind?: string;
  [key: string]: unknown;
}

export function fileDeps(file: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = fileDepsData(file, customDbPath, opts) as unknown as FileDepsData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

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

function printFnDepsCallees(callees: SymbolRef[]): void {
  if (callees.length === 0) return;
  console.log(`  -> Calls (${callees.length}):`);
  for (const c of callees) console.log(`    -> ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
}

function printFnDepsCallers(callers: CallerRef[]): void {
  if (callers.length === 0) return;
  console.log(`\n  <- Called by (${callers.length}):`);
  for (const c of callers) {
    const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
    console.log(`    <- ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
  }
}

function printFnDepsTransitive(transitiveCallers: Record<string, SymbolRef[]>): void {
  for (const [d, fns] of Object.entries(transitiveCallers)) {
    const depth = parseInt(d, 10);
    console.log(`\n  ${'<-'.repeat(depth)} Transitive callers (depth ${d}, ${fns.length}):`);
    for (const n of fns.slice(0, 20))
      console.log(
        `    ${'  '.repeat(depth - 1)}<- ${kindIcon(n.kind)} ${n.name}  ${n.file}:${n.line}`,
      );
    if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
  }
}

export function fnDeps(name: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = fnDepsData(name, customDbPath, opts) as unknown as FnDepsData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name} (${r.kind}) -- ${r.file}:${r.line}\n`);
    printFnDepsCallees(r.callees);
    printFnDepsCallers(r.callers);
    printFnDepsTransitive(r.transitiveCallers);
    if (r.callees.length === 0 && r.callers.length === 0) {
      console.log(`  (no call edges found -- may be invoked dynamically or via re-exports)`);
    }
    console.log();
  }
}

export function impactAnalysis(file: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = impactAnalysisData(file, customDbPath, opts) as unknown as ImpactData;
  if (outputResult(data as unknown as Record<string, unknown>, 'sources', opts)) return;

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
    for (const level of Object.keys(levels).sort((a, b) => Number(a) - Number(b))) {
      const nodes = levels[level]!;
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

export function fnImpact(name: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = fnImpactData(name, customDbPath, opts) as unknown as FnImpactData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\nFunction impact: ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}\n`);
    if (Object.keys(r.levels).length === 0) {
      console.log(`  No callers found.`);
    } else {
      for (const [level, fns] of Object.entries(r.levels).sort(
        (a, b) => Number(a[0]) - Number(b[0]),
      )) {
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

function printDiffFunctions(data: DiffImpactData): void {
  console.log(`\ndiff-impact: ${data.changedFiles} files changed\n`);
  console.log(`  ${data.affectedFunctions.length} functions changed:\n`);
  for (const fn of data.affectedFunctions) {
    console.log(`  ${kindIcon(fn.kind)} ${fn.name} -- ${fn.file}:${fn.line}`);
    if (fn.transitiveCallers > 0) console.log(`    ^ ${fn.transitiveCallers} transitive callers`);
  }
}

function printDiffCoupled(data: DiffImpactData): void {
  if (!data.historicallyCoupled?.length) return;
  console.log('\n  Historically coupled (not in static graph):\n');
  for (const c of data.historicallyCoupled) {
    const pct = `${(c.jaccard * 100).toFixed(0)}%`;
    console.log(
      `    ${c.file}  <- coupled with ${c.coupledWith} (${pct}, ${c.commitCount} commits)`,
    );
  }
}

function printDiffOwnership(data: DiffImpactData): void {
  if (!data.ownership) return;
  console.log(`\n  Affected owners: ${data.ownership.affectedOwners.join(', ')}`);
  console.log(`  Suggested reviewers: ${data.ownership.suggestedReviewers.join(', ')}`);
}

function printDiffBoundaries(data: DiffImpactData): void {
  if (!data.boundaryViolations?.length) return;
  console.log(`\n  Boundary violations (${data.boundaryViolationCount}):\n`);
  for (const v of data.boundaryViolations) {
    console.log(`    [${v.name}] ${v.file} -> ${v.targetFile}`);
    if (v.message) console.log(`      ${v.message}`);
  }
}

function printDiffSummary(summary: DiffSummary | undefined): void {
  if (!summary) return;
  let line = `\n  Summary: ${summary.functionsChanged} functions changed -> ${summary.callersAffected} callers affected across ${summary.filesAffected} files`;
  if (summary.historicallyCoupledCount > 0) {
    line += `, ${summary.historicallyCoupledCount} historically coupled`;
  }
  if (summary.ownersAffected > 0) {
    line += `, ${summary.ownersAffected} owners affected`;
  }
  if (summary.boundaryViolationCount > 0) {
    line += `, ${summary.boundaryViolationCount} boundary violations`;
  }
  console.log(`${line}\n`);
}

export function diffImpact(customDbPath: string, opts: OutputOpts = {}): void {
  if (opts.format === 'mermaid') {
    console.log(diffImpactMermaid(customDbPath, opts));
    return;
  }
  const data = diffImpactData(customDbPath, opts) as unknown as DiffImpactData;
  if (opts.format === 'json') opts = { ...opts, json: true };
  if (outputResult(data as unknown as Record<string, unknown>, 'affectedFunctions', opts)) return;

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

  printDiffFunctions(data);
  printDiffCoupled(data);
  printDiffOwnership(data);
  printDiffBoundaries(data);
  printDiffSummary(data.summary);
}
