import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '../db/better-sqlite3.js';
import { resolveBusyTimeoutMs } from '../db/index.js';
import { buildGraph } from '../domain/graph/builder.js';
import { kindIcon } from '../domain/queries.js';
import { debug } from '../infrastructure/logger.js';
import { getNative, isNativeAvailable } from '../infrastructure/native.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { toErrorMessage } from '../shared/errors.js';
import { toSymbolRef } from '../shared/normalize.js';
import type { BetterSqlite3Database, EngineMode, NativeDatabase } from '../types.js';

// ─── Git Helpers ────────────────────────────────────────────────────────

function validateGitRef(repoRoot: string, ref: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return sha;
  } catch (e) {
    debug(`validateGitRef failed for "${ref}": ${toErrorMessage(e)}`);
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
  } catch (e) {
    debug(`removeWorktree: git worktree remove failed for ${dir}: ${toErrorMessage(e)}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (rmErr) {
      debug(`removeWorktree: rmSync fallback failed for ${dir}: ${toErrorMessage(rmErr)}`);
    }
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (pruneErr) {
      debug(`removeWorktree: git worktree prune failed: ${toErrorMessage(pruneErr)}`);
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

interface RawNodeRow {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number | null;
}

/** Try opening a NativeDatabase handle for batched fan-in/fan-out metrics. */
function openNativeDbForFanMetrics(dbPath: string): NativeDatabase | undefined {
  if (!isNativeAvailable()) return undefined;
  try {
    const native = getNative();
    return native.NativeDatabase.openReadonly(dbPath, resolveBusyTimeoutMs(dbPath));
  } catch (e) {
    debug(`loadSymbolsFromDb: native path failed: ${toErrorMessage(e)}`);
    return undefined;
  }
}

/** Query all non-file/directory nodes belonging to the given changed files. */
function queryChangedFileNodes(db: BetterSqlite3Database, changedFiles: string[]): RawNodeRow[] {
  const placeholders = changedFiles.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line
       FROM nodes n
       WHERE n.file IN (${placeholders})
         AND n.kind NOT IN ('file', 'directory')
       ORDER BY n.file, n.line`,
    )
    .all(...changedFiles) as RawNodeRow[];
}

/** Build the public SymbolInfo shape from a raw row + its resolved fan metrics. */
function makeSymbolInfo(row: RawNodeRow, fanIn: number, fanOut: number): SymbolInfo {
  const lineCount = row.end_line ? row.end_line - row.line + 1 : 0;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    file: row.file,
    line: row.line,
    lineCount,
    fanIn,
    fanOut,
  };
}

/** Native fast path: batch all fan-in/fan-out lookups in one napi call. */
function buildSymbolsViaNativeBatch(
  filtered: RawNodeRow[],
  nativeDb: NativeDatabase,
): Map<string, SymbolInfo> {
  const symbols = new Map<string, SymbolInfo>();
  const nodeIds = filtered.map((r) => r.id);
  const metrics = nativeDb.batchFanMetrics!(nodeIds);
  const metricsMap = new Map(metrics.map((m) => [m.nodeId, m]));

  for (const row of filtered) {
    const m = metricsMap.get(row.id);
    const key = makeSymbolKey(row.kind, row.file, row.name);
    symbols.set(key, makeSymbolInfo(row, m?.fanIn ?? 0, m?.fanOut ?? 0));
  }
  return symbols;
}

/** JS fallback: per-row fan-in/fan-out COUNT queries. */
function buildSymbolsViaJsFallback(
  db: BetterSqlite3Database,
  filtered: RawNodeRow[],
): Map<string, SymbolInfo> {
  const symbols = new Map<string, SymbolInfo>();
  const fanInStmt = db.prepare(
    `SELECT COUNT(*) AS cnt FROM edges WHERE target_id = ? AND kind = 'calls'`,
  );
  const fanOutStmt = db.prepare(
    `SELECT COUNT(*) AS cnt FROM edges WHERE source_id = ? AND kind = 'calls'`,
  );

  for (const row of filtered) {
    const fanIn = (fanInStmt.get(row.id) as { cnt: number }).cnt;
    const fanOut = (fanOutStmt.get(row.id) as { cnt: number }).cnt;
    const key = makeSymbolKey(row.kind, row.file, row.name);
    symbols.set(key, makeSymbolInfo(row, fanIn, fanOut));
  }
  return symbols;
}

function loadSymbolsFromDb(
  dbPath: string,
  changedFiles: string[],
  noTests: boolean,
): Map<string, SymbolInfo> {
  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true });
  const nativeDb = openNativeDbForFanMetrics(dbPath);

  try {
    if (changedFiles.length === 0) {
      return new Map();
    }

    const rows = queryChangedFileNodes(db, changedFiles);

    // Filter first, then batch fan metrics for all surviving rows
    const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;

    if (nativeDb?.batchFanMetrics && filtered.length > 0) {
      return buildSymbolsViaNativeBatch(filtered, nativeDb);
    }

    return buildSymbolsViaJsFallback(db, filtered);
  } finally {
    db.close();
    if (nativeDb) {
      try {
        nativeDb.close();
      } catch (e) {
        debug(`loadSymbolsFromDb: nativeDb close failed: ${toErrorMessage(e)}`);
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
      bfsCallersFromNode(db, startId, maxDepth, noTests, allCallers);
    }

    return [...allCallers].map((s) => JSON.parse(s) as CallerInfo);
  } finally {
    db.close();
  }
}

/** Direct DB callers of a single node id (one BFS-frontier expansion step). */
function queryDirectCallers(
  db: BetterSqlite3Database,
  nodeId: number,
): Array<{ id: number; name: string; kind: string; file: string; line: number }> {
  return db
    .prepare(
      `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'calls'`,
    )
    .all(nodeId) as Array<{ id: number; name: string; kind: string; file: string; line: number }>;
}

/** BFS up to maxDepth from a single starting node, adding newly-seen callers to allCallers. */
function bfsCallersFromNode(
  db: BetterSqlite3Database,
  startId: number,
  maxDepth: number,
  noTests: boolean,
  allCallers: Set<string>,
): void {
  const visited = new Set<number>([startId]);
  let frontier = [startId];

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      const callers = queryDirectCallers(db, fid);
      for (const c of callers) {
        if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
          visited.add(c.id);
          nextFrontier.push(c.id);
          allCallers.add(JSON.stringify(toSymbolRef(c)));
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }
}

// ─── Symbol Comparison ──────────────────────────────────────────────────

/** Symbols present in `targetSymbols` but not `baseSymbols`. */
function findAddedSymbols(
  baseSymbols: Map<string, SymbolInfo>,
  targetSymbols: Map<string, SymbolInfo>,
): SymbolInfo[] {
  const added: SymbolInfo[] = [];
  for (const [key, sym] of targetSymbols) {
    if (!baseSymbols.has(key)) added.push(sym);
  }
  return added;
}

/** Symbols present in `baseSymbols` but not `targetSymbols`. */
function findRemovedSymbols(
  baseSymbols: Map<string, SymbolInfo>,
  targetSymbols: Map<string, SymbolInfo>,
): SymbolInfo[] {
  const removed: SymbolInfo[] = [];
  for (const [key, sym] of baseSymbols) {
    if (!targetSymbols.has(key)) removed.push(sym);
  }
  return removed;
}

/** Build a ChangedSymbol entry from a base/target pair whose metrics diverged. */
function buildChangedSymbol(baseSym: SymbolInfo, targetSym: SymbolInfo): ChangedSymbol | null {
  const lineCountDelta = targetSym.lineCount - baseSym.lineCount;
  const fanInDelta = targetSym.fanIn - baseSym.fanIn;
  const fanOutDelta = targetSym.fanOut - baseSym.fanOut;

  if (lineCountDelta === 0 && fanInDelta === 0 && fanOutDelta === 0) return null;

  return {
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
  };
}

/** Symbols present in both maps whose line count / fan-in / fan-out diverged. */
function findChangedSymbols(
  baseSymbols: Map<string, SymbolInfo>,
  targetSymbols: Map<string, SymbolInfo>,
): ChangedSymbol[] {
  const changed: ChangedSymbol[] = [];
  for (const [key, baseSym] of baseSymbols) {
    const targetSym = targetSymbols.get(key);
    if (!targetSym) continue;
    const entry = buildChangedSymbol(baseSym, targetSym);
    if (entry) changed.push(entry);
  }
  return changed;
}

function compareSymbols(
  baseSymbols: Map<string, SymbolInfo>,
  targetSymbols: Map<string, SymbolInfo>,
): { added: SymbolInfo[]; removed: SymbolInfo[]; changed: ChangedSymbol[] } {
  return {
    added: findAddedSymbols(baseSymbols, targetSymbols),
    removed: findRemovedSymbols(baseSymbols, targetSymbols),
    changed: findChangedSymbols(baseSymbols, targetSymbols),
  };
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

/**
 * Attach caller-impact data to each symbol, given a strategy for resolving
 * its DB node id (removed symbols carry their own id; changed symbols must
 * be looked up in the base-commit symbol map).
 */
function attachImpact<T>(
  symbols: T[],
  resolveId: (sym: T) => number | undefined,
  dbPath: string,
  maxDepth: number,
  noTests: boolean,
): void {
  for (const sym of symbols) {
    const id = resolveId(sym);
    const symCallers = loadCallersFromDb(dbPath, id ? [id] : [], maxDepth, noTests);
    (sym as T & { impact?: CallerInfo[] }).impact = symCallers;
  }
}

/** Confirm repoRoot is a git repo and resolve baseRef/targetRef to full SHAs. */
function validateBranchCompareRefs(
  repoRoot: string,
  baseRef: string,
  targetRef: string,
): { baseSha: string; targetSha: string } | { error: string } {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    debug(`branchCompareData: git check failed: ${toErrorMessage(e)}`);
    return { error: 'Not a git repository' };
  }

  const baseSha = validateGitRef(repoRoot, baseRef);
  if (!baseSha) return { error: `Invalid git ref: "${baseRef}"` };

  const targetSha = validateGitRef(repoRoot, targetRef);
  if (!targetSha) return { error: `Invalid git ref: "${targetRef}"` };

  return { baseSha, targetSha };
}

/** Create detached worktrees for both refs and build their graphs. */
async function setupCompareWorktrees(
  repoRoot: string,
  baseSha: string,
  targetSha: string,
  baseDir: string,
  targetDir: string,
  engine: EngineMode,
): Promise<{ baseDbPath: string; targetDbPath: string }> {
  createWorktree(repoRoot, baseSha, baseDir);
  createWorktree(repoRoot, targetSha, targetDir);

  await buildGraph(baseDir, { engine, skipRegistry: true });
  await buildGraph(targetDir, { engine, skipRegistry: true });

  return {
    baseDbPath: path.join(baseDir, '.codegraph', 'graph.db'),
    targetDbPath: path.join(targetDir, '.codegraph', 'graph.db'),
  };
}

interface SymbolDiffWithImpact {
  added: SymbolInfo[];
  removed: SymbolInfo[];
  changed: ChangedSymbol[];
  allImpacted: Set<string>;
  impactedFiles: Set<string>;
}

/** Resolve base-commit node ids for removed/changed symbols (for BFS impact queries). */
function resolveImpactfulIds(
  removed: SymbolInfo[],
  changed: ChangedSymbol[],
  baseSymbols: Map<string, SymbolInfo>,
): { removedIds: number[]; changedIds: number[] } {
  const removedIds = removed.map((s) => s.id).filter(Boolean);
  const changedIds = changed
    .map((s) => baseSymbols.get(makeSymbolKey(s.kind, s.file, s.name))?.id)
    .filter((id): id is number => Boolean(id));
  return { removedIds, changedIds };
}

/** Collapse removed+changed caller lists into the summary's impacted-symbol/file sets. */
function computeImpactedFileSets(
  removedImpact: CallerInfo[],
  changedImpact: CallerInfo[],
): { allImpacted: Set<string>; impactedFiles: Set<string> } {
  const allImpacted = new Set<string>();
  for (const c of removedImpact) allImpacted.add(`${c.file}:${c.name}`);
  for (const c of changedImpact) allImpacted.add(`${c.file}:${c.name}`);

  const impactedFiles = new Set<string>();
  for (const key of allImpacted) impactedFiles.add(key.split(':')[0]!);

  return { allImpacted, impactedFiles };
}

/** Load symbols from both DBs, diff them, and attach/compute blast-radius impact data. */
function diffSymbolsWithImpact(
  baseDbPath: string,
  targetDbPath: string,
  normalizedFiles: string[],
  noTests: boolean,
  maxDepth: number,
): SymbolDiffWithImpact {
  const baseSymbols = loadSymbolsFromDb(baseDbPath, normalizedFiles, noTests);
  const targetSymbols = loadSymbolsFromDb(targetDbPath, normalizedFiles, noTests);

  const { added, removed, changed } = compareSymbols(baseSymbols, targetSymbols);
  const { removedIds, changedIds } = resolveImpactfulIds(removed, changed, baseSymbols);

  const removedImpact = loadCallersFromDb(baseDbPath, removedIds, maxDepth, noTests);
  const changedImpact = loadCallersFromDb(baseDbPath, changedIds, maxDepth, noTests);

  attachImpact(removed, (s) => s.id, baseDbPath, maxDepth, noTests);
  attachImpact(
    changed,
    (s) => baseSymbols.get(makeSymbolKey(s.kind, s.file, s.name))?.id,
    baseDbPath,
    maxDepth,
    noTests,
  );

  const { allImpacted, impactedFiles } = computeImpactedFileSets(removedImpact, changedImpact);

  return { added, removed, changed, allImpacted, impactedFiles };
}

/** Strip the internal `.id` field, keeping `.impact` where it was attached. */
function shapeBranchCompareSymbolLists(
  added: SymbolInfo[],
  removed: SymbolInfo[],
): { cleanAdded: SymbolWithoutId[]; cleanRemoved: SymbolWithoutId[] } {
  const cleanAdded = added.map(({ id: _id, ...rest }) => rest as SymbolWithoutId);
  const cleanRemoved = removed.map(({ id: _id, ...rest }) => {
    const result = rest as SymbolWithoutId;
    if ((rest as SymbolInfo & { impact?: CallerInfo[] }).impact) {
      result.impact = (rest as SymbolInfo & { impact?: CallerInfo[] }).impact;
    }
    return result;
  });
  return { cleanAdded, cleanRemoved };
}

/** Result shape when there are no changed files between the two refs. */
function emptyBranchCompareResult(
  baseRef: string,
  targetRef: string,
  baseSha: string,
  targetSha: string,
): BranchCompareResult {
  return {
    baseRef,
    targetRef,
    baseSha,
    targetSha,
    changedFiles: [],
    added: [],
    removed: [],
    changed: [],
    summary: { added: 0, removed: 0, changed: 0, totalImpacted: 0, filesAffected: 0 },
  };
}

/** Assemble the final BranchCompareResult from the diff + cleaned symbol lists. */
function buildBranchCompareResult(
  refs: { baseRef: string; targetRef: string; baseSha: string; targetSha: string },
  normalizedFiles: string[],
  diff: SymbolDiffWithImpact,
  cleaned: { cleanAdded: SymbolWithoutId[]; cleanRemoved: SymbolWithoutId[] },
): BranchCompareResult {
  return {
    ...refs,
    changedFiles: normalizedFiles,
    added: cleaned.cleanAdded,
    removed: cleaned.cleanRemoved,
    changed: diff.changed,
    summary: {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      totalImpacted: diff.allImpacted.size,
      filesAffected: diff.impactedFiles.size,
    },
  };
}

/** Resolve branchCompareData's opts (repoRoot/maxDepth/noTests/engine) with their defaults. */
function resolveBranchCompareOptions(opts: BranchCompareOpts): {
  repoRoot: string;
  maxDepth: number;
  noTests: boolean;
  engine: EngineMode;
} {
  return {
    repoRoot: opts.repoRoot || process.cwd(),
    maxDepth: opts.depth || 3,
    noTests: opts.noTests || false,
    engine: (opts.engine || 'wasm') as EngineMode,
  };
}

/** Create the scratch tmpdir + base/target subdirectory paths for the dual worktrees. */
function createCompareTempDirs(): { tmpBase: string; baseDir: string; targetDir: string } {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bc-'));
  return { tmpBase, baseDir: path.join(tmpBase, 'base'), targetDir: path.join(tmpBase, 'target') };
}

/** Remove both worktrees and the scratch tmpdir (best-effort, always runs in `finally`). */
function cleanupCompareTempDirs(
  repoRoot: string,
  baseDir: string,
  targetDir: string,
  tmpBase: string,
): void {
  removeWorktree(repoRoot, baseDir);
  removeWorktree(repoRoot, targetDir);
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (cleanupErr) {
    debug(`branchCompareData: temp cleanup failed: ${toErrorMessage(cleanupErr)}`);
  }
}

/** Set up worktrees, diff the symbols, and shape the final result (the try-block body). */
async function runBranchCompareInWorktrees(
  resolvedRefs: { baseRef: string; targetRef: string; baseSha: string; targetSha: string },
  dirs: { repoRoot: string; baseDir: string; targetDir: string; engine: EngineMode },
  changedFiles: string[],
  noTests: boolean,
  maxDepth: number,
): Promise<BranchCompareResult> {
  const { baseSha, targetSha } = resolvedRefs;
  const { baseDbPath, targetDbPath } = await setupCompareWorktrees(
    dirs.repoRoot,
    baseSha,
    targetSha,
    dirs.baseDir,
    dirs.targetDir,
    dirs.engine,
  );

  const normalizedFiles = changedFiles.map((f) => f.replace(/\\/g, '/'));
  const diff = diffSymbolsWithImpact(baseDbPath, targetDbPath, normalizedFiles, noTests, maxDepth);
  const cleaned = shapeBranchCompareSymbolLists(diff.added, diff.removed);

  return buildBranchCompareResult(resolvedRefs, normalizedFiles, diff, cleaned);
}

export async function branchCompareData(
  baseRef: string,
  targetRef: string,
  opts: BranchCompareOpts = {},
): Promise<BranchCompareResult> {
  const { repoRoot, maxDepth, noTests, engine } = resolveBranchCompareOptions(opts);

  const refs = validateBranchCompareRefs(repoRoot, baseRef, targetRef);
  if ('error' in refs) return refs;
  const { baseSha, targetSha } = refs;

  try {
    const changedFiles = getChangedFilesBetweenRefs(repoRoot, baseSha, targetSha);

    if (changedFiles.length === 0) {
      return emptyBranchCompareResult(baseRef, targetRef, baseSha, targetSha);
    }

    const { tmpBase, baseDir, targetDir } = createCompareTempDirs();

    try {
      return await runBranchCompareInWorktrees(
        { baseRef, targetRef, baseSha, targetSha },
        { repoRoot, baseDir, targetDir, engine },
        changedFiles,
        noTests,
        maxDepth,
      );
    } finally {
      cleanupCompareTempDirs(repoRoot, baseDir, targetDir, tmpBase);
    }
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

// ─── Mermaid Output ─────────────────────────────────────────────────────

interface MermaidNodeIdState {
  counter: number;
  map: Map<string, string>;
}

function mermaidNodeId(state: MermaidNodeIdState, key: string): string {
  if (!state.map.has(key)) {
    state.map.set(key, `n${state.counter++}`);
  }
  return state.map.get(key)!;
}

function addMermaidSubgraph(
  lines: string[],
  state: MermaidNodeIdState,
  prefix: string,
  label: string,
  symbols: Array<{ kind: string; file: string; name: string }>,
  fillColor: string,
  strokeColor: string,
): void {
  if (symbols.length === 0) return;
  lines.push(`    subgraph sg_${prefix}["${label}"]`);
  for (const sym of symbols) {
    const key = `${prefix}::${sym.kind}::${sym.file}::${sym.name}`;
    const nid = mermaidNodeId(state, key);
    lines.push(`        ${nid}["[${kindIcon(sym.kind)}] ${sym.name}"]`);
  }
  lines.push('    end');
  lines.push(`    style sg_${prefix} fill:${fillColor},stroke:${strokeColor}`);
}

function collectImpactedCallers(
  impactSources: Array<{ impact?: CallerInfo[] }>,
): Map<string, CallerInfo> {
  const allImpacted = new Map<string, CallerInfo>();
  for (const sym of impactSources) {
    if (!sym.impact) continue;
    for (const c of sym.impact) {
      const key = `impact::${c.kind}::${c.file}::${c.name}`;
      if (!allImpacted.has(key)) allImpacted.set(key, c);
    }
  }
  return allImpacted;
}

/** Render the "Impacted Callers" subgraph block, if there are any impacted callers. */
function renderImpactedCallersSubgraph(
  lines: string[],
  state: MermaidNodeIdState,
  allImpacted: Map<string, CallerInfo>,
): void {
  if (allImpacted.size === 0) return;
  lines.push('    subgraph sg_impact["Impacted Callers"]');
  for (const [key, c] of allImpacted) {
    const nid = mermaidNodeId(state, key);
    lines.push(`        ${nid}["[${kindIcon(c.kind)}] ${c.name}"]`);
  }
  lines.push('    end');
  lines.push('    style sg_impact fill:#f3e5f5,stroke:#9c27b0');
}

/** Draw the dotted "impacted by" edges from each removed/changed symbol to its callers. */
function renderImpactEdges(
  lines: string[],
  state: MermaidNodeIdState,
  impactSources: Array<{ kind: string; file: string; name: string; impact?: CallerInfo[] }>,
  removed: SymbolWithoutId[],
): void {
  for (const sym of impactSources) {
    if (!sym.impact) continue;
    const prefix = removed.includes(sym as SymbolWithoutId) ? 'removed' : 'changed';
    const symKey = `${prefix}::${sym.kind}::${sym.file}::${sym.name}`;
    for (const c of sym.impact) {
      const callerKey = `impact::${c.kind}::${c.file}::${c.name}`;
      if (state.map.has(symKey) && state.map.has(callerKey)) {
        lines.push(`    ${state.map.get(symKey)} -.-> ${state.map.get(callerKey)}`);
      }
    }
  }
}

/** True if the compare result has no added/removed/changed symbols to render. */
function hasNoBranchDifferences(data: BranchCompareResult): boolean {
  return (
    (data.added?.length ?? 0) === 0 &&
    (data.removed?.length ?? 0) === 0 &&
    (data.changed?.length ?? 0) === 0
  );
}

/** Render the three top-level Added/Removed/Changed subgraphs. */
function renderAddedRemovedChangedSubgraphs(
  lines: string[],
  state: MermaidNodeIdState,
  data: BranchCompareResult,
): void {
  addMermaidSubgraph(lines, state, 'added', 'Added', data.added || [], '#e8f5e9', '#4caf50');
  addMermaidSubgraph(lines, state, 'removed', 'Removed', data.removed || [], '#ffebee', '#f44336');
  addMermaidSubgraph(lines, state, 'changed', 'Changed', data.changed || [], '#fff3e0', '#ff9800');
}

export function branchCompareMermaid(data: BranchCompareResult): string {
  if (data.error) return data.error;
  if (hasNoBranchDifferences(data)) {
    return 'flowchart TB\n    none["No structural differences detected"]';
  }

  const lines = ['flowchart TB'];
  const state: MermaidNodeIdState = { counter: 0, map: new Map() };

  renderAddedRemovedChangedSubgraphs(lines, state, data);

  const impactSources = [...(data.removed || []), ...(data.changed || [])];
  const allImpacted = collectImpactedCallers(impactSources);

  renderImpactedCallersSubgraph(lines, state, allImpacted);
  renderImpactEdges(lines, state, impactSources, data.removed || []);

  return lines.join('\n');
}
