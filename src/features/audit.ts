import path from 'node:path';
import { openReadonlyOrFail } from '../db/index.js';
import { normalizeFileFilter } from '../db/query-builder.js';
import { bfsTransitiveCallers } from '../domain/analysis/impact.js';
import { explainData } from '../domain/queries.js';
import { loadConfig } from '../infrastructure/config.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../types.js';
import { RULE_DEFS } from './manifesto.js';

// ─── Threshold resolution ───────────────────────────────────────────

interface ThresholdEntry {
  metric: string;
  warn: number | null;
  fail: number | null;
}

const FUNCTION_RULES = RULE_DEFS.filter((d: { level: string }) => d.level === 'function');

function resolveThresholds(
  customDbPath: string | undefined,
  config: unknown,
): Record<string, ThresholdEntry> {
  try {
    const cfg =
      config ||
      (() => {
        const dbDir = path.dirname(customDbPath!);
        const repoRoot = path.resolve(dbDir, '..');
        return loadConfig(repoRoot);
      })();
    const userRules = (cfg as Record<string, unknown>)['manifesto'] || {};
    const resolved: Record<string, ThresholdEntry> = {};
    for (const def of FUNCTION_RULES) {
      const user = (userRules as Record<string, { warn?: number; fail?: number }>)[def.name];
      resolved[def.name] = {
        metric: def.metric,
        warn: user?.warn !== undefined ? user.warn : def.defaults.warn,
        fail: def.reportOnly ? null : user?.fail !== undefined ? user.fail : def.defaults.fail,
      };
    }
    return resolved;
  } catch {
    // Fall back to defaults if config loading fails
    const resolved: Record<string, ThresholdEntry> = {};
    for (const def of FUNCTION_RULES) {
      resolved[def.name] = {
        metric: def.metric,
        warn: def.defaults.warn,
        fail: def.reportOnly ? null : def.defaults.fail,
      };
    }
    return resolved;
  }
}

// Column name in DB → threshold rule name mapping
const METRIC_TO_RULE: Record<string, string> = {
  cognitive: 'cognitive',
  cyclomatic: 'cyclomatic',
  max_nesting: 'maxNesting',
};

interface ThresholdBreach {
  metric: string;
  value: number;
  threshold: number;
  level: 'warn' | 'fail';
}

function checkBreaches(
  row: Record<string, unknown>,
  thresholds: Record<string, ThresholdEntry>,
): ThresholdBreach[] {
  const breaches: ThresholdBreach[] = [];
  for (const [col, ruleName] of Object.entries(METRIC_TO_RULE)) {
    const t = thresholds[ruleName];
    if (!t) continue;
    const value = row[col] as number | null | undefined;
    if (value == null) continue;
    if (t.fail != null && value >= t.fail) {
      breaches.push({ metric: ruleName, value, threshold: t.fail, level: 'fail' });
    } else if (t.warn != null && value >= t.warn) {
      breaches.push({ metric: ruleName, value, threshold: t.warn, level: 'warn' });
    }
  }
  return breaches;
}

// ─── Phase 4.4 fields (graceful null fallback) ─────────────────────

interface Phase44Fields {
  riskScore: number | null;
  complexityNotes: string | null;
  sideEffects: string | null;
}

function readPhase44(db: BetterSqlite3Database, nodeId: number): Phase44Fields {
  try {
    const row = db
      .prepare('SELECT risk_score, complexity_notes, side_effects FROM nodes WHERE id = ?')
      .get(nodeId) as
      | { risk_score?: number; complexity_notes?: string; side_effects?: string }
      | undefined;
    if (row) {
      return {
        riskScore: row.risk_score ?? null,
        complexityNotes: row.complexity_notes ?? null,
        sideEffects: row.side_effects ?? null,
      };
    }
  } catch {
    /* columns don't exist yet */
  }
  return { riskScore: null, complexityNotes: null, sideEffects: null };
}

// ─── auditData ──────────────────────────────────────────────────────

interface SymbolRef {
  name: string;
  kind: string;
  file: string;
  line: number;
}

interface HealthMetrics {
  cognitive: number | null;
  cyclomatic: number | null;
  maxNesting: number | null;
  maintainabilityIndex: number | null;
  halstead: { volume: number; difficulty: number; effort: number; bugs: number };
  loc: number;
  sloc: number;
  commentLines: number;
  thresholdBreaches: ThresholdBreach[];
}

interface AuditDataOpts {
  noTests?: boolean;
  config?: CodegraphConfig;
  depth?: number;
  file?: string;
  kind?: string;
}

export function auditData(
  target: string,
  customDbPath?: string,
  opts: AuditDataOpts = {},
): { target: string; kind: string; functions: unknown[] } {
  const noTests = opts.noTests || false;
  const config = opts.config || loadConfig();
  const maxDepth =
    opts.depth ||
    (config as unknown as { analysis?: { auditDepth?: number } }).analysis?.auditDepth ||
    3;
  const fileFilters = normalizeFileFilter(opts.file);
  const kind = opts.kind;

  // 1. Get structure via explainData
  const explained = explainData(target, customDbPath!, { noTests, depth: 0 });

  // Apply --file and --kind filters for function targets
  // biome-ignore lint/suspicious/noExplicitAny: explainData returns a union type that varies by kind
  let results: any[] = explained.results;
  if (explained.kind === 'function') {
    if (fileFilters.length > 0)
      results = results.filter((r: { file: string }) =>
        fileFilters.some((f: string) => r.file.includes(f)),
      );
    if (kind) results = results.filter((r: { kind: string }) => r.kind === kind);
  }

  if (results.length === 0) {
    return { target, kind: explained.kind, functions: [] };
  }

  // 2. Open DB for enrichment
  const db = openReadonlyOrFail(customDbPath);
  const thresholds = resolveThresholds(customDbPath, opts.config);

  let functions: unknown[];
  try {
    if (explained.kind === 'file') {
      // File target: explainData returns file-level info with publicApi + internal
      // We need to enrich each symbol
      functions = [];
      for (const fileResult of results) {
        const allSymbols = [
          ...(fileResult.publicApi || []),
          ...(fileResult.internal || []),
        ] as FileSymbol[];
        if (kind) {
          const filtered = allSymbols.filter((s) => s.kind === kind);
          for (const sym of filtered) {
            functions.push(enrichSymbol(db, sym, fileResult.file, noTests, maxDepth, thresholds));
          }
        } else {
          for (const sym of allSymbols) {
            functions.push(enrichSymbol(db, sym, fileResult.file, noTests, maxDepth, thresholds));
          }
        }
      }
    } else {
      // Function target: explainData returns per-function results
      functions = results.map((r: ExplainResult) =>
        enrichFunction(db, r, noTests, maxDepth, thresholds),
      );
    }
  } finally {
    db.close();
  }

  return { target, kind: explained.kind, functions };
}

// ─── Enrich a function result from explainData ──────────────────────

interface ExplainResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine?: number | null;
  role?: string | null;
  lineCount?: number | null;
  summary?: string | null;
  signature?: string | null;
  callees?: SymbolRef[];
  callers?: SymbolRef[];
  relatedTests?: { file: string }[];
}

function enrichFunction(
  db: BetterSqlite3Database,
  r: ExplainResult,
  noTests: boolean,
  maxDepth: number,
  thresholds: Record<string, ThresholdEntry>,
): unknown {
  const nodeRow = db
    .prepare('SELECT id FROM nodes WHERE name = ? AND file = ? AND line = ?')
    .get(r.name, r.file, r.line) as { id: number } | undefined;

  const nodeId = nodeRow?.id;
  const health = nodeId ? buildHealth(db, nodeId, thresholds) : defaultHealth();
  const impact = nodeId
    ? bfsTransitiveCallers(db, nodeId, { noTests, maxDepth })
    : { totalDependents: 0, levels: {} };
  const phase44 = nodeId
    ? readPhase44(db, nodeId)
    : { riskScore: null, complexityNotes: null, sideEffects: null };

  return {
    name: r.name,
    kind: r.kind,
    file: r.file,
    line: r.line,
    endLine: r.endLine,
    role: r.role,
    lineCount: r.lineCount,
    summary: r.summary,
    signature: r.signature,
    callees: r.callees,
    callers: r.callers,
    relatedTests: r.relatedTests,
    impact,
    health,
    ...phase44,
  };
}

// ─── Enrich a symbol from file-level explainData ────────────────────

interface FileSymbol {
  name: string;
  kind: string;
  line: number;
  role?: string | null;
  summary?: string | null;
  signature?: string | null;
}

function enrichSymbol(
  db: BetterSqlite3Database,
  sym: FileSymbol,
  file: string,
  noTests: boolean,
  maxDepth: number,
  thresholds: Record<string, ThresholdEntry>,
): unknown {
  const nodeRow = db
    .prepare('SELECT id, end_line FROM nodes WHERE name = ? AND file = ? AND line = ?')
    .get(sym.name, file, sym.line) as { id: number; end_line: number | null } | undefined;

  const nodeId = nodeRow?.id;
  const endLine = nodeRow?.end_line || null;
  const lineCount = endLine ? endLine - sym.line + 1 : null;

  // Get callers/callees for this symbol
  let callees: SymbolRef[] = [];
  let callers: SymbolRef[] = [];
  let relatedTests: { file: string }[] = [];
  if (nodeId) {
    callees = (
      db
        .prepare(
          `SELECT n.name, n.kind, n.file, n.line
         FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind = 'calls'`,
        )
        .all(nodeId) as SymbolRef[]
    ).map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));

    callers = (
      db
        .prepare(
          `SELECT n.name, n.kind, n.file, n.line
         FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
        )
        .all(nodeId) as SymbolRef[]
    ).map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));
    if (noTests) callers = callers.filter((c) => !isTestFile(c.file));

    const testCallerRows = db
      .prepare(
        `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(nodeId) as { file: string }[];
    relatedTests = testCallerRows.filter((r) => isTestFile(r.file)).map((r) => ({ file: r.file }));
  }

  const health = nodeId ? buildHealth(db, nodeId, thresholds) : defaultHealth();
  const impact = nodeId
    ? bfsTransitiveCallers(db, nodeId, { noTests, maxDepth })
    : { totalDependents: 0, levels: {} };
  const phase44 = nodeId
    ? readPhase44(db, nodeId)
    : { riskScore: null, complexityNotes: null, sideEffects: null };

  return {
    name: sym.name,
    kind: sym.kind,
    file,
    line: sym.line,
    endLine,
    role: sym.role || null,
    lineCount,
    summary: sym.summary || null,
    signature: sym.signature || null,
    callees,
    callers,
    relatedTests,
    impact,
    health,
    ...phase44,
  };
}

// ─── Build health metrics from function_complexity ──────────────────

interface ComplexityRow {
  cognitive: number;
  cyclomatic: number;
  max_nesting: number;
  maintainability_index: number | null;
  halstead_volume: number | null;
  halstead_difficulty: number | null;
  halstead_effort: number | null;
  halstead_bugs: number | null;
  loc: number | null;
  sloc: number | null;
  comment_lines: number | null;
}

function buildHealth(
  db: BetterSqlite3Database,
  nodeId: number,
  thresholds: Record<string, ThresholdEntry>,
): HealthMetrics {
  try {
    const row = db
      .prepare(
        `SELECT cognitive, cyclomatic, max_nesting, maintainability_index,
                halstead_volume, halstead_difficulty, halstead_effort, halstead_bugs,
                loc, sloc, comment_lines
         FROM function_complexity WHERE node_id = ?`,
      )
      .get(nodeId) as ComplexityRow | undefined;

    if (!row) return defaultHealth();

    return {
      cognitive: row.cognitive,
      cyclomatic: row.cyclomatic,
      maxNesting: row.max_nesting,
      maintainabilityIndex: row.maintainability_index || 0,
      halstead: {
        volume: row.halstead_volume || 0,
        difficulty: row.halstead_difficulty || 0,
        effort: row.halstead_effort || 0,
        bugs: row.halstead_bugs || 0,
      },
      loc: row.loc || 0,
      sloc: row.sloc || 0,
      commentLines: row.comment_lines || 0,
      thresholdBreaches: checkBreaches(row as unknown as Record<string, unknown>, thresholds),
    };
  } catch {
    /* table may not exist */
    return defaultHealth();
  }
}

function defaultHealth(): HealthMetrics {
  return {
    cognitive: null,
    cyclomatic: null,
    maxNesting: null,
    maintainabilityIndex: null,
    halstead: { volume: 0, difficulty: 0, effort: 0, bugs: 0 },
    loc: 0,
    sloc: 0,
    commentLines: 0,
    thresholdBreaches: [],
  };
}
