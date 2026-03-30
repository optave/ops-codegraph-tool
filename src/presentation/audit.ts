import { kindIcon } from '../domain/queries.js';
import { auditData } from '../features/audit.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface AuditOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  file?: string;
  kind?: string;
  quick?: boolean;
  limit?: number;
  offset?: number;
  depth?: number;
  config?: unknown;
}

/** Render health metrics for a single audit function. */
function renderHealthMetrics(fn: any): void {
  if (fn.health.cognitive == null) return;
  console.log(`\n  Health:`);
  console.log(
    `    Cognitive: ${fn.health.cognitive}  Cyclomatic: ${fn.health.cyclomatic}  Nesting: ${fn.health.maxNesting}`,
  );
  console.log(`    MI: ${fn.health.maintainabilityIndex}`);
  if (fn.health.halstead.volume) {
    console.log(
      `    Halstead: vol=${fn.health.halstead.volume} diff=${fn.health.halstead.difficulty} effort=${fn.health.halstead.effort} bugs=${fn.health.halstead.bugs}`,
    );
  }
  if (fn.health.loc) {
    console.log(
      `    LOC: ${fn.health.loc}  SLOC: ${fn.health.sloc}  Comments: ${fn.health.commentLines}`,
    );
  }
}

/** Render a single audited function with all its sections. */
function renderAuditFunction(fn: any): void {
  const lineRange = fn.endLine ? `${fn.line}-${fn.endLine}` : `${fn.line}`;
  const roleTag = fn.role ? ` [${fn.role}]` : '';
  console.log(`## ${kindIcon(fn.kind)} ${fn.name} (${fn.kind})${roleTag}`);
  console.log(`  ${fn.file}:${lineRange}${fn.lineCount ? ` (${fn.lineCount} lines)` : ''}`);
  if (fn.summary) console.log(`  ${fn.summary}`);
  if (fn.signature) {
    if (fn.signature.params != null) console.log(`  Parameters: (${fn.signature.params})`);
    if (fn.signature.returnType) console.log(`  Returns: ${fn.signature.returnType}`);
  }

  renderHealthMetrics(fn);

  if (fn.health.thresholdBreaches.length > 0) {
    console.log(`\n  Threshold Breaches:`);
    for (const b of fn.health.thresholdBreaches) {
      const icon = b.level === 'fail' ? 'FAIL' : 'WARN';
      console.log(`    [${icon}] ${b.metric}: ${b.value} >= ${b.threshold}`);
    }
  }

  console.log(`\n  Impact: ${fn.impact.totalDependents} transitive dependent(s)`);
  for (const [level, nodes] of Object.entries(fn.impact.levels)) {
    console.log(
      `    Level ${level}: ${(nodes as Array<{ name: string }>).map((n) => n.name).join(', ')}`,
    );
  }

  if (fn.callees.length > 0) {
    console.log(`\n  Calls (${fn.callees.length}):`);
    for (const c of fn.callees) {
      console.log(`    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
    }
  }
  if (fn.callers.length > 0) {
    console.log(`\n  Called by (${fn.callers.length}):`);
    for (const c of fn.callers) {
      console.log(`    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
    }
  }
  if (fn.relatedTests.length > 0) {
    console.log(`\n  Tests (${fn.relatedTests.length}):`);
    for (const t of fn.relatedTests) {
      console.log(`    ${t.file}`);
    }
  }

  console.log();
}

export function audit(
  target: string,
  customDbPath: string | undefined,
  opts: AuditOpts = {},
): void {
  const data: any = auditData(target, customDbPath, opts as any);

  if (outputResult(data, null, opts)) return;

  if (data.functions.length === 0) {
    console.log(`No ${data.kind === 'file' ? 'file' : 'function/symbol'} matching "${target}"`);
    return;
  }

  console.log(`\n# Audit: ${target} (${data.kind})`);
  console.log(`  ${data.functions.length} function(s) analyzed\n`);

  for (const fn of data.functions) {
    renderAuditFunction(fn);
  }
}
