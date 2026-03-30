import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '../db/better-sqlite3.js';
import { buildGraph } from '../domain/graph/builder.js';
import { kindIcon } from '../domain/queries.js';
import { debug } from '../infrastructure/logger.js';
import { getNative, isNativeAvailable } from '../infrastructure/native.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import type { EngineMode, NativeDatabase } from '../types.js';

// ─── Git Helpers ────────────────────────────────────────────────────────

function validateGitRef(repoRoot: string, ref: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return sha;
  } catch {
    return null;
  }
}

function getChangedFilesBetweenRefs(repoRoot: string, base: string, target: string): string[] {
  const output = execFileSync('git', ['diff', '--name-only', `${base}..${target}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

function createWorktree(repoRoot: string, ref: string, dir: string): void {
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function removeWorktree(repoRoot: string, dir: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      /* best-effort */
    }
  }
}

// ─── Symbol Loading ─────────────────────────────────────────────────────

interface SymbolInfo {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  lineCount: number;
  fanIn: number;
  fanOut: number;
}

interface CallerInfo {
  name: string;
  kind: string;
  file: string;
  line: number;
}

interface ChangedSymbol {
  name: string;
  kind: string;
  file: string;
  base: { line: number; lineCount: number; fanIn: number; fanOut: number };
  target: { line: number; lineCount: number; fanIn: number; fanOut: number };
  changes: { lineCount: number; fanIn: number; fanOut: number };
  impact?: CallerInfo[];
}

function makeSymbolKey(kind: string, file: string, name: string): string {
  return `${kind}::${file}::${name}`;
}

function loadSymbolsFromDb(
  dbPath: string,
  changedFiles: string[],
  noTests: boolean,
): Map<string, SymbolInfo> {
  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true });

  // Try opening a NativeDatabase for batched fan metrics
  let nativeDb: NativeDatabase | undefined;
  if (isNativeAvailable()) {
    try {
      const native = getNative();
      nativeDb = native.NativeDatabase.openReadonly(dbPath);
    } catch (e) {
      debug(`loadSymbolsFromDb: native path failed: ${(e as Error).message}`);
    }
  }

  try {
    const symbols = new Map<string, SymbolInfo>();

    if (changedFiles.length === 0) {
      return symbols;
    }

    const placeholders = changedFiles.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line
         FROM nodes n
         WHERE n.file IN (${placeholders})
           AND n.kind NOT IN ('file', 'directory')
         ORDER BY n.file, n.line`,
      )
      .all(...changedFiles) as Array<{
      id: number;
      name: string;
      kind: string;
      file: string;
      line: number;
      end_line: number | null;
    }>;

    // Filter first, then batch fan metrics for all surviving rows
    const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;

    // ── Native fast path: batch all fan-in/fan-out in one napi call ──
    if (nativeDb?.batchFanMetrics && filtered.length > 0) {
      const nodeIds = filtered.map((r) => r.id);
      const metrics = nativeDb.batchFanMetrics(nodeIds);
      const metricsMap = new Map(metrics.map((m) => [m.nodeId, m]));

      for (const row of filtered) {
        const lineCount = row.end_line ? row.end_line - row.line + 1 : 0;
        const m = metricsMap.get(row.id);
        const key = makeSymbolKey(row.kind, row.file, row.name);
        symbols.set(key, {
          id: row.id,
          name: row.name,
          kind: row.kind,
          file: row.file,
          line: row.line,
          lineCount,
          fanIn: m?.fanIn ?? 0,
          fanOut: m?.fanOut ?? 0,
        });
      }
      return symbols;
    }

    // ── JS fallback ───────────────────────────────────────────────────
    const fanInStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM edges WHERE target_id = ? AND kind = 'calls'`,
    );
    const fanOutStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM edges WHERE source_id = ? AND kind = 'calls'`,
    );

    for (const row of filtered) {
      const lineCount = row.end_line ? row.end_line - row.line + 1 : 0;
      const fanIn = (fanInStmt.get(row.id) as { cnt: number }).cnt;
      const fanOut = (fanOutStmt.get(row.id) as { cnt: number }).cnt;
      const key = makeSymbolKey(row.kind, row.file, row.name);

      symbols.set(key, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        lineCount,
        fanIn,
        fanOut,
      });
    }

    return symbols;
  } finally {
    db.close();
    if (nativeDb) {
      try {
        nativeDb.close();
      } catch {
        /* already closed */
      }
    }
  }
}

// ─── Caller BFS ─────────────────────────────────────────────────────────

function loadCallersFromDb(
  dbPath: string,
  nodeIds: number[],
  maxDepth: number,
  noTests: boolean,
): CallerInfo[] {
  if (nodeIds.length === 0) return [];

  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true });
  try {
    const allCallers = new Set<string>();

    for (const startId of nodeIds) {
      const visited = new Set<number>([startId]);
      let frontier = [startId];

      for (let d = 1; d <= maxDepth; d++) {
        const nextFrontier: number[] = [];
        for (const fid of frontier) {
          const callers = db
            .prepare(
              `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
               FROM edges e JOIN nodes n ON e.source_id = n.id
               WHERE e.target_id = ? AND e.kind = 'calls'`,
            )
            .all(fid) as Array<{
            id: number;
            name: string;
            kind: string;
            file: string;
            line: number;
          }>;

          for (const c of callers) {
            if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
              visited.add(c.id);
              nextFrontier.push(c.id);
              allCallers.add(
                JSON.stringify({ name: c.name, kind: c.kind, file: c.file, line: c.line }),
              );
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }
    }

    return [...allCallers].map((s) => JSON.parse(s) as CallerInfo);
  } finally {
    db.close();
  }
}

// ─── Symbol Comparison ──────────────────────────────────────────────────

function compareSymbols(
  baseSymbols: Map<string, SymbolInfo>,
  targetSymbols: Map<string, SymbolInfo>,
): { added: SymbolInfo[]; removed: SymbolInfo[]; changed: ChangedSymbol[] } {
  const added: SymbolInfo[] = [];
  const removed: SymbolInfo[] = [];
  const changed: ChangedSymbol[] = [];

  for (const [key, sym] of targetSymbols) {
    if (!baseSymbols.has(key)) {
      added.push(sym);
    }
  }

  for (const [key, sym] of baseSymbols) {
    if (!targetSymbols.has(key)) {
      removed.push(sym);
    }
  }

  for (const [key, baseSym] of baseSymbols) {
    const targetSym = targetSymbols.get(key);
    if (!targetSym) continue;

    const lineCountDelta = targetSym.lineCount - baseSym.lineCount;
    const fanInDelta = targetSym.fanIn - baseSym.fanIn;
    const fanOutDelta = targetSym.fanOut - baseSym.fanOut;

    if (lineCountDelta !== 0 || fanInDelta !== 0 || fanOutDelta !== 0) {
      changed.push({
        name: baseSym.name,
        kind: baseSym.kind,
        file: baseSym.file,
        base: {
          line: baseSym.line,
          lineCount: baseSym.lineCount,
          fanIn: baseSym.fanIn,
          fanOut: baseSym.fanOut,
        },
        target: {
          line: targetSym.line,
          lineCount: targetSym.lineCount,
          fanIn: targetSym.fanIn,
          fanOut: targetSym.fanOut,
        },
        changes: {
          lineCount: lineCountDelta,
          fanIn: fanInDelta,
          fanOut: fanOutDelta,
        },
      });
    }
  }

  return { added, removed, changed };
}

// ─── Main Data Function ─────────────────────────────────────────────────

interface BranchCompareOpts {
  repoRoot?: string;
  depth?: number;
  noTests?: boolean;
  engine?: string;
}

interface BranchCompareSummary {
  added: number;
  removed: number;
  changed: number;
  totalImpacted: number;
  filesAffected: number;
}

type SymbolWithoutId = Omit<SymbolInfo, 'id'> & { impact?: CallerInfo[] };

interface BranchCompareResult {
  error?: string;
  baseRef?: string;
  targetRef?: string;
  baseSha?: string;
  targetSha?: string;
  changedFiles?: string[];
  added?: SymbolWithoutId[];
  removed?: SymbolWithoutId[];
  changed?: ChangedSymbol[];
  summary?: BranchCompareSummary;
}

export async function branchCompareData(
  baseRef: string,
  targetRef: string,
  opts: BranchCompareOpts = {},
): Promise<BranchCompareResult> {
  const repoRoot = opts.repoRoot || process.cwd();
  const maxDepth = opts.depth || 3;
  const noTests = opts.noTests || false;
  const engine = (opts.engine || 'wasm') as EngineMode;

  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return { error: 'Not a git repository' };
  }

  const baseSha = validateGitRef(repoRoot, baseRef);
  if (!baseSha) return { error: `Invalid git ref: "${baseRef}"` };

  const targetSha = validateGitRef(repoRoot, targetRef);
  if (!targetSha) return { error: `Invalid git ref: "${targetRef}"` };

  const changedFiles = getChangedFilesBetweenRefs(repoRoot, baseSha, targetSha);

  if (changedFiles.length === 0) {
    return {
      baseRef,
      targetRef,
      baseSha,
      targetSha,
      changedFiles: [],
      added: [],
      removed: [],
      changed: [],
      summary: {
        added: 0,
        removed: 0,
        changed: 0,
        totalImpacted: 0,
        filesAffected: 0,
      },
    };
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bc-'));
  const baseDir = path.join(tmpBase, 'base');
  const targetDir = path.join(tmpBase, 'target');

  try {
    createWorktree(repoRoot, baseSha, baseDir);
    createWorktree(repoRoot, targetSha, targetDir);

    await buildGraph(baseDir, { engine, skipRegistry: true });
    await buildGraph(targetDir, { engine, skipRegistry: true });

    const baseDbPath = path.join(baseDir, '.codegraph', 'graph.db');
    const targetDbPath = path.join(targetDir, '.codegraph', 'graph.db');

    const normalizedFiles = changedFiles.map((f) => f.replace(/\\/g, '/'));

    const baseSymbols = loadSymbolsFromDb(baseDbPath, normalizedFiles, noTests);
    const targetSymbols = loadSymbolsFromDb(targetDbPath, normalizedFiles, noTests);

    const { added, removed, changed } = compareSymbols(baseSymbols, targetSymbols);

    const removedIds = removed.map((s) => s.id).filter(Boolean);
    const changedIds = changed
      .map((s) => {
        const baseSym = baseSymbols.get(makeSymbolKey(s.kind, s.file, s.name));
        return baseSym?.id;
      })
      .filter((id): id is number => Boolean(id));

    const removedImpact = loadCallersFromDb(baseDbPath, removedIds, maxDepth, noTests);
    const changedImpact = loadCallersFromDb(baseDbPath, changedIds, maxDepth, noTests);

    for (const sym of removed) {
      const symCallers = loadCallersFromDb(baseDbPath, sym.id ? [sym.id] : [], maxDepth, noTests);
      (sym as SymbolInfo & { impact?: CallerInfo[] }).impact = symCallers;
    }
    for (const sym of changed) {
      const baseSym = baseSymbols.get(makeSymbolKey(sym.kind, sym.file, sym.name));
      const symCallers = loadCallersFromDb(
        baseDbPath,
        baseSym?.id ? [baseSym.id] : [],
        maxDepth,
        noTests,
      );
      sym.impact = symCallers;
    }

    const allImpacted = new Set<string>();
    for (const c of removedImpact) allImpacted.add(`${c.file}:${c.name}`);
    for (const c of changedImpact) allImpacted.add(`${c.file}:${c.name}`);

    const impactedFiles = new Set<string>();
    for (const key of allImpacted) impactedFiles.add(key.split(':')[0]!);

    const cleanAdded = added.map(({ id: _id, ...rest }) => rest as SymbolWithoutId);
    const cleanRemoved = removed.map(({ id: _id, ...rest }) => {
      const result = rest as SymbolWithoutId;
      if ((rest as SymbolInfo & { impact?: CallerInfo[] }).impact) {
        result.impact = (rest as SymbolInfo & { impact?: CallerInfo[] }).impact;
      }
      return result;
    });

    return {
      baseRef,
      targetRef,
      baseSha,
      targetSha,
      changedFiles: normalizedFiles,
      added: cleanAdded,
      removed: cleanRemoved,
      changed,
      summary: {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        totalImpacted: allImpacted.size,
        filesAffected: impactedFiles.size,
      },
    };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    removeWorktree(repoRoot, baseDir);
    removeWorktree(repoRoot, targetDir);
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ─── Mermaid Output ─────────────────────────────────────────────────────

export function branchCompareMermaid(data: BranchCompareResult): string {
  if (data.error) return data.error;
  if (
    (data.added?.length ?? 0) === 0 &&
    (data.removed?.length ?? 0) === 0 &&
    (data.changed?.length ?? 0) === 0
  ) {
    return 'flowchart TB\n    none["No structural differences detected"]';
  }

  const lines = ['flowchart TB'];
  let nodeCounter = 0;
  const nodeIdMap = new Map<string, string>();

  function nodeId(key: string): string {
    if (!nodeIdMap.has(key)) {
      nodeIdMap.set(key, `n${nodeCounter++}`);
    }
    return nodeIdMap.get(key)!;
  }

  if (data.added && data.added.length > 0) {
    lines.push('    subgraph sg_added["Added"]');
    for (const sym of data.added) {
      const key = `added::${sym.kind}::${sym.file}::${sym.name}`;
      const nid = nodeId(key);
      lines.push(`        ${nid}["[${kindIcon(sym.kind)}] ${sym.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_added fill:#e8f5e9,stroke:#4caf50');
  }

  if (data.removed && data.removed.length > 0) {
    lines.push('    subgraph sg_removed["Removed"]');
    for (const sym of data.removed) {
      const key = `removed::${sym.kind}::${sym.file}::${sym.name}`;
      const nid = nodeId(key);
      lines.push(`        ${nid}["[${kindIcon(sym.kind)}] ${sym.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_removed fill:#ffebee,stroke:#f44336');
  }

  if (data.changed && data.changed.length > 0) {
    lines.push('    subgraph sg_changed["Changed"]');
    for (const sym of data.changed) {
      const key = `changed::${sym.kind}::${sym.file}::${sym.name}`;
      const nid = nodeId(key);
      lines.push(`        ${nid}["[${kindIcon(sym.kind)}] ${sym.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_changed fill:#fff3e0,stroke:#ff9800');
  }

  const allImpacted = new Map<string, CallerInfo>();
  const impactSources = [...(data.removed || []), ...(data.changed || [])];
  for (const sym of impactSources) {
    if (!sym.impact) continue;
    for (const c of sym.impact) {
      const key = `impact::${c.kind}::${c.file}::${c.name}`;
      if (!allImpacted.has(key)) allImpacted.set(key, c);
    }
  }

  if (allImpacted.size > 0) {
    lines.push('    subgraph sg_impact["Impacted Callers"]');
    for (const [key, c] of allImpacted) {
      const nid = nodeId(key);
      lines.push(`        ${nid}["[${kindIcon(c.kind)}] ${c.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_impact fill:#f3e5f5,stroke:#9c27b0');
  }

  for (const sym of impactSources) {
    if (!sym.impact) continue;
    const prefix = (data.removed || []).includes(sym as SymbolWithoutId) ? 'removed' : 'changed';
    const symKey = `${prefix}::${sym.kind}::${sym.file}::${sym.name}`;
    for (const c of sym.impact) {
      const callerKey = `impact::${c.kind}::${c.file}::${c.name}`;
      if (nodeIdMap.has(symKey) && nodeIdMap.has(callerKey)) {
        lines.push(`    ${nodeIdMap.get(symKey)} -.-> ${nodeIdMap.get(callerKey)}`);
      }
    }
  }

  return lines.join('\n');
}
