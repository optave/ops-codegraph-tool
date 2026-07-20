import { kindIcon } from '../domain/queries.js';
import { auditData } from '../features/audit.js';
import { outputResult } from '../infrastructure/result-formatter.js';
import type { AuditFunctionEntry, AuditResult, CodegraphConfig } from '../types.js';
import {
  renderCallRefsSection,
  renderNoCallEdgesFallback,
  renderRelatedTestsSection,
} from './call-ref-sections.js';
import { renderImpactLevels } from './impact-levels.js';

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
  config?: CodegraphConfig;
}

/** Render health metrics for a single audit function. */
function renderHealthMetrics(fn: AuditFunctionEntry): void {
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

/** Render the name/kind/location/summary/signature header for an audited function. */
function renderFunctionHeader(fn: AuditFunctionEntry): void {
  const lineRange = fn.endLine ? `${fn.line}-${fn.endLine}` : `${fn.line}`;
  const roleTag = fn.role ? ` [${fn.role}]` : '';
  console.log(`## ${kindIcon(fn.kind)} ${fn.name} (${fn.kind})${roleTag}`);
  console.log(`  ${fn.file}:${lineRange}${fn.lineCount ? ` (${fn.lineCount} lines)` : ''}`);
  if (fn.summary) console.log(`  ${fn.summary}`);
  if (fn.signature) {
    if (fn.signature.params != null) console.log(`  Parameters: (${fn.signature.params})`);
    if (fn.signature.returnType) console.log(`  Returns: ${fn.signature.returnType}`);
  }
}

/** Render manifesto threshold breaches (cognitive/cyclomatic/nesting over warn/fail limits). */
function renderThresholdBreaches(fn: AuditFunctionEntry): void {
  if (fn.health.thresholdBreaches.length === 0) return;
  console.log(`\n  Threshold Breaches:`);
  for (const b of fn.health.thresholdBreaches) {
    const icon = b.level === 'fail' ? 'FAIL' : 'WARN';
    console.log(`    [${icon}] ${b.metric}: ${b.value} >= ${b.threshold}`);
  }
}

/** Render the transitive-dependent impact summary, one block per BFS level. */
function renderImpactSection(fn: AuditFunctionEntry): void {
  console.log(`\n  Impact: ${fn.impact.totalDependents} transitive dependent(s)`);
  // No "0 found" message here -- the count above already conveys it, matching the
  // shared call-ref-sections helpers below, which print nothing when empty.
  renderImpactLevels(fn.impact.levels, { emptyMessage: null });
}

/** Render a single audited function with all its sections. */
function renderAuditFunction(fn: AuditFunctionEntry): void {
  renderFunctionHeader(fn);
  renderHealthMetrics(fn);
  renderThresholdBreaches(fn);
  renderImpactSection(fn);
  renderCallRefsSection('Calls', fn.callees);
  renderCallRefsSection('Called by', fn.callers);
  renderRelatedTestsSection(fn.relatedTests);
  renderNoCallEdgesFallback(fn.callees.length, fn.callers.length);

  console.log();
}

export function audit(
  target: string,
  customDbPath: string | undefined,
  opts: AuditOpts = {},
): void {
  const data: AuditResult = auditData(target, customDbPath, opts);

  if (outputResult(data, null, opts)) return;

  if (data.functions.length === 0) {
    if (data.found === false) {
      console.log(`No ${data.kind === 'file' ? 'file' : 'function/symbol'} matching "${target}"`);
    } else {
      console.log(`No functions to audit in "${target}" (0 own function/method/class definitions)`);
    }
    return;
  }

  console.log(`\n# Audit: ${target} (${data.kind})`);
  console.log(`  ${data.functions.length} function(s) analyzed\n`);

  for (const fn of data.functions) {
    renderAuditFunction(fn);
  }
}
