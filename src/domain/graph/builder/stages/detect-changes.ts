/**
 * Stage: detectChanges
 *
 * Determines which files have changed since the last build using a tiered
 * strategy: journal → mtime+size → content hash.  Handles full, incremental,
 * and scoped rebuilds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDb } from '../../../../db/index.js';
import { debug, info } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
import { toErrorMessage } from '../../../../shared/errors.js';
import type { BetterSqlite3Database, ExtractorOutput, NativeDatabase } from '../../../../types.js';
import { parseFilesAuto } from '../../../parser.js';
import { readJournal, writeJournalHeader } from '../../journal.js';
import type { PipelineContext } from '../context.js';
import { fileHash, fileStat, purgeFilesFromGraph, readFileSafe } from '../helpers.js';

// ── Local types ────────────────────────────────────────────────────────

interface FileHashRow {
  file: string;
  hash: string;
  mtime: number;
  size: number;
}

interface FileStat {
  mtime: number;
  size: number;
}

interface ChangedFile {
  file: string;
  relPath?: string;
  content?: string;
  hash?: string;
  stat?: FileStat;
  metadataOnly?: boolean;
  _reverseDepOnly?: boolean;
}

interface ChangeResult {
  changed: ChangedFile[];
  removed: string[];
  isFullBuild: boolean;
}

interface NeedsHashItem {
  file: string;
  relPath: string;
  stat?: FileStat;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getChangedFiles(
  db: BetterSqlite3Database,
  allFiles: string[],
  rootDir: string,
): ChangeResult {
  // NativeDatabase is not open during change detection (deferred to after
  // early-exit check). All queries use better-sqlite3 here.
  let hasTable = false;
  try {
    db.prepare('SELECT 1 FROM file_hashes LIMIT 1').get();
    hasTable = true;
  } catch (e) {
    debug(`file_hashes table probe failed, assuming table doesn't exist: ${toErrorMessage(e)}`);
  }

  if (!hasTable) {
    return {
      changed: allFiles.map((f) => ({ file: f })),
      removed: [],
      isFullBuild: true,
    };
  }

  const rows = db.prepare('SELECT file, hash, mtime, size FROM file_hashes').all() as FileHashRow[];
  const existing = new Map<string, FileHashRow>(rows.map((r) => [r.file, r]));

  const removed = detectRemovedFiles(existing, allFiles, rootDir);
  const journalResult = tryJournalTier(db, existing, rootDir, removed);
  if (journalResult) return journalResult;
  return mtimeAndHashTiers(existing, allFiles, rootDir, removed);
}

function detectRemovedFiles(
  existing: Map<string, FileHashRow>,
  allFiles: string[],
  rootDir: string,
): string[] {
  const currentFiles = new Set<string>();
  for (const file of allFiles) {
    currentFiles.add(normalizePath(path.relative(rootDir, file)));
  }
  const removed: string[] = [];
  for (const existingFile of existing.keys()) {
    if (!currentFiles.has(existingFile)) {
      removed.push(existingFile);
    }
  }
  return removed;
}

function tryJournalTier(
  db: BetterSqlite3Database,
  existing: Map<string, FileHashRow>,
  rootDir: string,
  removed: string[],
  precomputedMaxMtime?: number,
): ChangeResult | null {
  const journal = readJournal(rootDir);
  if (!journal.valid) return null;

  const latestDbMtime =
    precomputedMaxMtime ??
    ((
      db.prepare('SELECT MAX(mtime) as latest FROM file_hashes').get() as
        | { latest: number | null }
        | undefined
    )?.latest ||
      0);
  const hasJournalEntries = journal.changed!.length > 0 || journal.removed!.length > 0;

  if (!hasJournalEntries || journal.timestamp! < latestDbMtime) {
    debug(
      `Tier 0: skipped (${hasJournalEntries ? 'timestamp stale' : 'no entries'}), falling to Tier 1`,
    );
    return null;
  }

  debug(
    `Tier 0: journal valid, ${journal.changed!.length} changed, ${journal.removed!.length} removed`,
  );
  const changed: ChangedFile[] = [];

  for (const relPath of journal.changed!) {
    const absPath = path.join(rootDir, relPath);
    const stat = fileStat(absPath) as FileStat | undefined;
    if (!stat) continue;
    let content: string | undefined;
    try {
      content = readFileSafe(absPath);
    } catch {
      continue;
    }
    const hash = fileHash(content);
    const record = existing.get(relPath);
    if (!record || record.hash !== hash) {
      changed.push({ file: absPath, content, hash, relPath, stat });
    }
  }

  const removedSet = new Set(removed);
  for (const relPath of journal.removed!) {
    if (existing.has(relPath)) removedSet.add(relPath);
  }

  return { changed, removed: [...removedSet], isFullBuild: false };
}

/** Tier 1: mtime+size triage. Returns the files that still need hashing. */
function tierMtimeSize(
  existing: Map<string, FileHashRow>,
  allFiles: string[],
  rootDir: string,
): { needsHash: NeedsHashItem[]; skipped: number } {
  const needsHash: NeedsHashItem[] = [];
  let skipped = 0;

  for (const file of allFiles) {
    const relPath = normalizePath(path.relative(rootDir, file));
    const record = existing.get(relPath);
    if (!record) {
      needsHash.push({ file, relPath });
      continue;
    }
    const stat = fileStat(file) as FileStat | undefined;
    if (!stat) continue;
    const storedMtime = record.mtime || 0;
    const storedSize = record.size || 0;
    if (storedSize > 0 && stat.mtime === storedMtime && stat.size === storedSize) {
      skipped++;
      continue;
    }
    needsHash.push({ file, relPath, stat });
  }

  return { needsHash, skipped };
}

/** Tier 2: hash candidates from tier 1, classifying changed vs metadata-only. */
function tierHash(existing: Map<string, FileHashRow>, needsHash: NeedsHashItem[]): ChangedFile[] {
  const changed: ChangedFile[] = [];
  for (const item of needsHash) {
    let content: string | undefined;
    try {
      content = readFileSafe(item.file);
    } catch {
      continue;
    }
    const hash = fileHash(content);
    const stat = item.stat || (fileStat(item.file) as FileStat | undefined);
    const record = existing.get(item.relPath);
    if (!record || record.hash !== hash) {
      changed.push({ file: item.file, content, hash, relPath: item.relPath, stat });
    } else if (stat) {
      changed.push({
        file: item.file,
        content,
        hash,
        relPath: item.relPath,
        stat,
        metadataOnly: true,
      });
    }
  }
  return changed;
}

function mtimeAndHashTiers(
  existing: Map<string, FileHashRow>,
  allFiles: string[],
  rootDir: string,
  removed: string[],
): ChangeResult {
  const { needsHash, skipped } = tierMtimeSize(existing, allFiles, rootDir);
  if (needsHash.length > 0) {
    debug(`Tier 1: ${skipped} skipped by mtime+size, ${needsHash.length} need hash check`);
  }

  const changed = tierHash(existing, needsHash);

  if (needsHash.length > 0) {
    const parseChangedLen = changed.filter((c) => !c.metadataOnly).length;
    debug(
      `Tier 2: ${parseChangedLen} actually changed, ${changed.length - parseChangedLen} metadata-only`,
    );
  }

  return { changed, removed, isFullBuild: false };
}

async function runPendingAnalysis(ctx: PipelineContext): Promise<boolean> {
  const { db, opts, engineOpts, allFiles, rootDir } = ctx;
  const useNative = ctx.engineName === 'native' && !!ctx.nativeDb?.checkPendingAnalysis;

  let needsCfg: boolean;
  let needsDataflow: boolean;

  if (useNative) {
    const counts = ctx.nativeDb!.checkPendingAnalysis!();
    needsCfg = (opts as Record<string, unknown>).cfg !== false && counts.cfgCount <= 0;
    needsDataflow =
      (opts as Record<string, unknown>).dataflow !== false && counts.dataflowCount <= 0;
  } else {
    needsCfg =
      (opts as Record<string, unknown>).cfg !== false &&
      (() => {
        try {
          return (
            (db.prepare('SELECT COUNT(*) as c FROM cfg_blocks').get() as { c: number } | undefined)
              ?.c === 0
          );
        } catch {
          return true;
        }
      })();
    needsDataflow =
      (opts as Record<string, unknown>).dataflow !== false &&
      (() => {
        try {
          return (
            (db.prepare('SELECT COUNT(*) as c FROM dataflow').get() as { c: number } | undefined)
              ?.c === 0
          );
        } catch {
          return true;
        }
      })();
  }
  if (!needsCfg && !needsDataflow) return false;

  info('No file changes. Running pending analysis pass...');
  const analysisOpts = {
    ...engineOpts,
    dataflow: needsDataflow && (opts as Record<string, unknown>).dataflow !== false,
  };
  const analysisSymbols: Map<string, ExtractorOutput> = await parseFilesAuto(
    allFiles,
    rootDir,
    analysisOpts,
  );
  const { runAnalyses } = await import('../../../../ast-analysis/engine.js');
  await runAnalyses(
    db,
    analysisSymbols,
    rootDir,
    { ast: false, complexity: false, cfg: needsCfg, dataflow: needsDataflow },
    engineOpts,
  );
  return true;
}

function healMetadata(ctx: PipelineContext): void {
  const { db, metadataUpdates } = ctx;
  if (!metadataUpdates || metadataUpdates.length === 0) return;
  try {
    if (ctx.engineName === 'native' && ctx.nativeDb?.healFileMetadata) {
      const entries = metadataUpdates.map((item) => ({
        file: item.relPath,
        hash: item.hash,
        mtime: item.stat ? Math.floor(item.stat.mtime) : 0,
        size: item.stat ? item.stat.size : 0,
      }));
      ctx.nativeDb.healFileMetadata(entries);
    } else {
      const healHash = db.prepare(
        'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
      );
      const healTx = db.transaction(() => {
        for (const item of metadataUpdates) {
          const mtime = item.stat ? Math.floor(item.stat.mtime) : 0;
          const size = item.stat ? item.stat.size : 0;
          healHash.run(item.relPath, item.hash, mtime, size);
        }
      });
      healTx();
    }
    debug(`Self-healed mtime/size for ${metadataUpdates.length} files`);
  } catch (e) {
    debug(`Self-heal of mtime/size metadata failed: ${toErrorMessage(e)}`);
  }
}

function findReverseDependencies(
  db: BetterSqlite3Database,
  changedRelPaths: Set<string>,
  rootDir: string,
  nativeDb?: NativeDatabase,
): Set<string> {
  const reverseDeps = new Set<string>();
  if (changedRelPaths.size === 0) return reverseDeps;

  if (nativeDb?.findReverseDependencies) {
    const changedArray = [...changedRelPaths];
    const nativeResults = nativeDb.findReverseDependencies(changedArray);
    for (const dep of nativeResults) {
      const absPath = path.isAbsolute(dep) ? dep : path.join(rootDir, dep);
      if (fs.existsSync(absPath)) {
        reverseDeps.add(dep);
      }
    }
    return reverseDeps;
  }

  const findReverseDepsStmt = db.prepare(`
    SELECT DISTINCT n_src.file FROM edges e
    JOIN nodes n_src ON e.source_id = n_src.id
    JOIN nodes n_tgt ON e.target_id = n_tgt.id
    WHERE n_tgt.file = ? AND n_src.file != n_tgt.file AND n_src.kind != 'directory'
  `);
  for (const relPath of changedRelPaths) {
    for (const row of findReverseDepsStmt.all(relPath) as Array<{ file: string }>) {
      if (!changedRelPaths.has(row.file) && !reverseDeps.has(row.file)) {
        const absPath = path.isAbsolute(row.file) ? row.file : path.join(rootDir, row.file);
        if (fs.existsSync(absPath)) {
          reverseDeps.add(row.file);
        }
      }
    }
  }
  return reverseDeps;
}

/**
 * Captures the forward+reverse import-neighbor file set for files about to be
 * removed, BEFORE `purgeFilesFromGraph`/`purgeFilesData` deletes their edges.
 *
 * `refreshAffectedDirectoryMetrics` discovers cross-directory neighbors by
 * querying LIVE import edges from the affected directories — this works for
 * added/modified files (their edges are rebuilt and still present) but not
 * for removed files, whose edges in both directions are purged before
 * `buildStructure` runs. Reading them here, one step earlier in the pipeline,
 * closes that gap: the neighbor files' ancestor directories are unioned into
 * the affected-directory set so a directory whose only link to the touched
 * set was an edge to/from a now-removed file still gets its fan-in/fan-out
 * recomputed (#1839).
 */
function captureRemovedFileNeighbors(db: BetterSqlite3Database, removedFiles: string[]): string[] {
  if (removedFiles.length === 0) return [];
  const removedSet = new Set(removedFiles);
  const neighbors = new Set<string>();
  const neighborStmt = db.prepare(`
    SELECT n2.file AS other FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id
    WHERE e.kind IN ('imports', 'imports-type') AND n1.file != n2.file AND n1.file = ?
    UNION
    SELECT n1.file AS other FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id
    WHERE e.kind IN ('imports', 'imports-type') AND n1.file != n2.file AND n2.file = ?
  `);
  for (const relPath of removedFiles) {
    for (const row of neighborStmt.all(relPath, relPath) as Array<{ other: string }>) {
      if (!removedSet.has(row.other)) neighbors.add(row.other);
    }
  }
  return [...neighbors];
}

/**
 * Computes the sorted line list for every (name, kind) sibling group within
 * `file`, keyed by `name|kind`.
 *
 * A file can contain multiple distinct symbols with the identical name and
 * kind — e.g. several object-literal `close() {}` methods returned from
 * different functions in the same file. `(name, kind, file)` alone is not a
 * unique identity for such symbols, so `reconnectReverseDepEdges` cannot
 * safely tell them apart by nearest-line matching once unrelated code shifts
 * the candidates unevenly, or a same-named sibling is added/removed in the
 * same edit (#1752, #1865). The sorted line list captured here — the
 * sibling group's layout at save time — lets reconnection align old targets
 * to their correct new nodes by rank when the sibling count is unchanged,
 * or by the dominant line-shift that best explains the surviving siblings
 * when it changed (see `alignSiblingLines` in `build-edges.ts`), which
 * tolerates both a uniform shift of the whole group AND a change in the
 * group's size.
 */
function computeSiblingGroups(db: BetterSqlite3Database, file: string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const rows = db.prepare('SELECT name, kind, line FROM nodes WHERE file = ?').all(file) as Array<{
    name: string;
    kind: string;
    line: number;
  }>;
  for (const row of rows) {
    const groupKey = `${row.name}|${row.kind}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(row.line);
  }
  for (const lines of groups.values()) lines.sort((a, b) => a - b);
  return groups;
}

/**
 * Reconnects reverse-dep files to the changed files they depend on.
 *
 * Native path: purgeFilesData already deleted + rebuilt the affected edges in
 * one transaction, so this just enqueues the reverse-dep files for reparse
 * (works correctly with the native edge builder).
 *
 * WASM/JS path: saves the edge topology from reverse-dep files → changed
 * files BEFORE purge runs, so it can be reconnected to new node IDs after
 * insertNodes (#932, #933). purgeFilesFromGraph deletes edges in BOTH
 * directions for changed files, which already removes the reverse-dep →
 * changed-file edges. The old approach then over-deleted ALL outgoing edges
 * from reverse-dep files and reparsed them to rebuild everything — expensive
 * (87 extra parses) and lossy (442 missing edges due to imperfect resolution
 * on rebuild). This approach saves the edge topology, lets purge handle
 * deletion, then reconnects using new node IDs. No reparse needed.
 */
function addReverseDeps(
  ctx: PipelineContext,
  changePaths: string[],
  reverseDeps: Set<string>,
  hasPurge: boolean,
): void {
  const { db, rootDir } = ctx;
  if (ctx.engineName === 'native' && ctx.nativeDb?.purgeFilesData) {
    for (const relPath of reverseDeps) {
      const absPath = path.join(rootDir, relPath);
      ctx.parseChanges.push({ file: absPath, relPath, _reverseDepOnly: true });
    }
    return;
  }

  if (!(reverseDeps.size > 0 && hasPurge)) return;
  const changePathSet = new Set(changePaths);
  const saveEdgesStmt = db.prepare(`
    SELECT e.source_id, n_tgt.name AS tgt_name, n_tgt.kind AS tgt_kind,
           n_tgt.file AS tgt_file, n_tgt.line AS tgt_line,
           e.kind AS edge_kind, e.confidence, e.dynamic, e.technique, e.dynamic_kind,
           n_src.file AS src_file
    FROM edges e
    JOIN nodes n_src ON e.source_id = n_src.id
    JOIN nodes n_tgt ON e.target_id = n_tgt.id
    WHERE n_tgt.file = ? AND n_src.file != n_tgt.file
  `);
  for (const changedPath of changePaths) {
    // Must be computed BEFORE this file's nodes are purged — captures the
    // pre-purge sibling layout so reconnection can map old→new correctly
    // even when several same-named/same-kind symbols exist in the file.
    const groups = computeSiblingGroups(db, changedPath);
    for (const row of saveEdgesStmt.all(changedPath) as Array<{
      source_id: number;
      tgt_name: string;
      tgt_kind: string;
      tgt_file: string;
      tgt_line: number;
      edge_kind: string;
      confidence: number;
      dynamic: number;
      technique: string | null;
      dynamic_kind: string | null;
      src_file: string;
    }>) {
      // Skip edges whose source is also being purged — buildEdges will
      // re-create them with correct new IDs.
      if (changePathSet.has(row.src_file)) continue;
      const groupKey = `${row.tgt_name}|${row.tgt_kind}|${row.tgt_file}`;
      if (!ctx.savedSiblingGroups.has(groupKey)) {
        ctx.savedSiblingGroups.set(
          groupKey,
          groups.get(`${row.tgt_name}|${row.tgt_kind}`) ?? [row.tgt_line],
        );
      }
      ctx.savedReverseDepEdges.push({
        sourceId: row.source_id,
        tgtName: row.tgt_name,
        tgtKind: row.tgt_kind,
        tgtFile: row.tgt_file,
        tgtLine: row.tgt_line,
        edgeKind: row.edge_kind,
        confidence: row.confidence,
        dynamic: row.dynamic,
        technique: row.technique,
        dynamicKind: row.dynamic_kind,
      });
    }
  }
  debug(`Saved ${ctx.savedReverseDepEdges.length} reverse-dep edges for reconnection`);
}

/**
 * Deletes graph data for removed/changed files (and, on the native path,
 * their reverse-dep edges) in one call. See `addReverseDeps` for the
 * counterpart that reconnects reverse-dep topology around this deletion.
 */
function purgeStaleReverseDeps(
  ctx: PipelineContext,
  filesToPurge: string[],
  hasPurge: boolean,
  hasReverseDeps: boolean,
  reverseDepList: string[],
): void {
  // Prefer NativeDatabase: purge + reverse-dep edge deletion in one transaction (#670)
  if (ctx.engineName === 'native' && ctx.nativeDb?.purgeFilesData) {
    ctx.nativeDb.purgeFilesData(filesToPurge, false, hasReverseDeps ? reverseDepList : undefined);
    return;
  }
  // No outgoing-edge deletion for reverse-deps — purge already removed
  // edges targeting the changed files, and other outgoing edges are valid.
  // No reverse-deps added to parseChanges — no reparse needed.
  if (hasPurge) {
    purgeFilesFromGraph(ctx.db, filesToPurge, { purgeHashes: false });
  }
}

function purgeAndAddReverseDeps(
  ctx: PipelineContext,
  changePaths: string[],
  reverseDeps: Set<string>,
): void {
  const hasPurge = changePaths.length > 0 || ctx.removed.length > 0;
  const hasReverseDeps = reverseDeps.size > 0;
  const reverseDepList = hasReverseDeps ? [...reverseDeps] : [];

  if (!(hasPurge || hasReverseDeps)) return;

  const filesToPurge = hasPurge ? [...ctx.removed, ...changePaths] : [];
  const isNative = ctx.engineName === 'native' && !!ctx.nativeDb?.purgeFilesData;

  if (isNative) {
    // Native: purge (which also rebuilds reverse-dep edges) runs first, then
    // the reverse-dep files are enqueued for reparse.
    purgeStaleReverseDeps(ctx, filesToPurge, hasPurge, hasReverseDeps, reverseDepList);
    addReverseDeps(ctx, changePaths, reverseDeps, hasPurge);
  } else {
    // WASM/JS: edge topology must be saved BEFORE purge deletes it.
    addReverseDeps(ctx, changePaths, reverseDeps, hasPurge);
    purgeStaleReverseDeps(ctx, filesToPurge, hasPurge, hasReverseDeps, reverseDepList);
  }
}

function detectHasEmbeddings(db: BetterSqlite3Database, nativeDb?: NativeDatabase): boolean {
  if (nativeDb?.hasEmbeddings) {
    return nativeDb.hasEmbeddings();
  }
  try {
    db.prepare('SELECT 1 FROM embeddings LIMIT 1').get();
    return true;
  } catch {
    return false;
  }
}

function handleScopedBuild(ctx: PipelineContext): void {
  const { db, rootDir, opts } = ctx;
  ctx.hasEmbeddings = detectHasEmbeddings(db, ctx.nativeDb);
  const changePaths = ctx.parseChanges.map(
    (item) => item.relPath || normalizePath(path.relative(rootDir, item.file)),
  );
  let reverseDeps = new Set<string>();
  if (!(opts as Record<string, unknown>).noReverseDeps) {
    const changedRelPaths = new Set<string>([...changePaths, ...ctx.removed]);
    reverseDeps = findReverseDependencies(db, changedRelPaths, rootDir, ctx.nativeDb);
  }
  ctx.removedFileNeighbors = captureRemovedFileNeighbors(db, ctx.removed);
  purgeAndAddReverseDeps(ctx, changePaths, reverseDeps);
  info(
    `Scoped rebuild: ${changePaths.length} changed, ${ctx.removed.length} removed, ${reverseDeps.size} reverse-deps`,
  );
}

function handleFullBuild(ctx: PipelineContext): void {
  const { db } = ctx;
  const hasEmbeddings = detectHasEmbeddings(db, ctx.nativeDb);
  ctx.hasEmbeddings = hasEmbeddings;
  const deletions =
    'PRAGMA foreign_keys = OFF; DELETE FROM cfg_edges; DELETE FROM cfg_blocks; DELETE FROM node_metrics; DELETE FROM edges; DELETE FROM function_complexity; DELETE FROM dataflow; DELETE FROM ast_nodes; DELETE FROM nodes; DELETE FROM file_hashes; PRAGMA foreign_keys = ON;';
  db.exec(
    hasEmbeddings
      ? `${deletions.replace('PRAGMA foreign_keys = ON;', '')} DELETE FROM embeddings; PRAGMA foreign_keys = ON;`
      : deletions,
  );
}

function handleIncrementalBuild(ctx: PipelineContext): void {
  const { db, rootDir, opts } = ctx;
  ctx.hasEmbeddings = detectHasEmbeddings(db, ctx.nativeDb);
  let reverseDeps = new Set<string>();
  if (!(opts as Record<string, unknown>).noReverseDeps) {
    const changedRelPaths = new Set<string>();
    for (const item of ctx.parseChanges) {
      changedRelPaths.add(item.relPath || normalizePath(path.relative(rootDir, item.file)));
    }
    for (const relPath of ctx.removed) {
      changedRelPaths.add(relPath);
    }
    reverseDeps = findReverseDependencies(db, changedRelPaths, rootDir, ctx.nativeDb);
  }
  info(
    `Incremental: ${ctx.parseChanges.length} changed, ${ctx.removed.length} removed${reverseDeps.size > 0 ? `, ${reverseDeps.size} reverse-deps` : ''}`,
  );
  if (ctx.parseChanges.length > 0)
    debug(`Changed files: ${ctx.parseChanges.map((c) => c.relPath).join(', ')}`);
  if (ctx.removed.length > 0) debug(`Removed files: ${ctx.removed.join(', ')}`);
  const changePaths = ctx.parseChanges.map(
    (item) => item.relPath || normalizePath(path.relative(rootDir, item.file)),
  );
  ctx.removedFileNeighbors = captureRemovedFileNeighbors(db, ctx.removed);
  purgeAndAddReverseDeps(ctx, changePaths, reverseDeps);
}

/**
 * Diagnostic logger gated by `build.fastSkipDiag` config (resolved by the
 * caller from `config.build.fastSkipDiag`, which `applyEnvOverrides` sets
 * from `CODEGRAPH_FAST_SKIP_DIAG` — see `infrastructure/config.ts`). Used by
 * both `detectNoChanges` branches.
 */
function makeFastSkipLogger(fastSkipDiag: boolean): (reason: string) => void {
  return (reason: string): void => {
    if (fastSkipDiag) info(`[fast-skip] ${reason}`);
  };
}

/**
 * Load the `file_hashes` table for the no-change pre-flight.  Returns null
 * if the table is missing or empty (both → caller must fall through).
 */
function loadFileHashesForPreflight(
  db: BetterSqlite3Database,
  log: (reason: string) => void,
): Map<string, FileHashRow> | null {
  try {
    db.prepare('SELECT 1 FROM file_hashes LIMIT 1').get();
  } catch {
    log('false: file_hashes table missing');
    return null;
  }
  const rows = db.prepare('SELECT file, hash, mtime, size FROM file_hashes').all() as FileHashRow[];
  if (rows.length === 0) {
    log('false: file_hashes table empty');
    return null;
  }
  return new Map<string, FileHashRow>(rows.map((r) => [r.file, r]));
}

/** Returns true iff every file in `allFiles` matches a stored mtime+size record. */
function allFilesMatchStoredStat(
  existing: Map<string, FileHashRow>,
  allFiles: string[],
  rootDir: string,
  log: (reason: string) => void,
): boolean {
  const currentFiles = new Set<string>();
  for (const file of allFiles) {
    currentFiles.add(normalizePath(path.relative(rootDir, file)));
  }
  for (const existingFile of existing.keys()) {
    if (!currentFiles.has(existingFile)) {
      log(`false: tracked file no longer collected: ${existingFile}`);
      return false;
    }
  }

  for (const file of allFiles) {
    const relPath = normalizePath(path.relative(rootDir, file));
    const record = existing.get(relPath);
    if (!record) {
      log(`false: collected file missing from file_hashes: ${relPath}`);
      return false;
    }
    const stat = fileStat(file) as FileStat | undefined;
    if (!stat) {
      log(`false: stat failed for ${relPath}`);
      return false;
    }
    const storedMtime = record.mtime || 0;
    const storedSize = record.size || 0;
    if (storedSize <= 0) {
      log(`false: stored size <= 0 for ${relPath} (stored=${record.size})`);
      return false;
    }
    if (stat.mtime !== storedMtime || stat.size !== storedSize) {
      log(
        `false: mtime/size diff for ${relPath}: stat=${stat.mtime}/${stat.size} stored=${storedMtime}/${storedSize}`,
      );
      return false;
    }
  }
  return true;
}

/**
 * Pending-analysis guard: if CFG/dataflow is enabled but the corresponding
 * table is empty (analysis newly enabled, or tables wiped between builds),
 * fall through so the orchestrator / JS pipeline can run runPendingAnalysis.
 * Mirrors the check at the top of runPendingAnalysis.
 */
function passesPendingAnalysisGuard(
  db: BetterSqlite3Database,
  opts: Record<string, unknown> | undefined,
  log: (reason: string) => void,
): boolean {
  if (!opts) return true;
  if (opts.cfg !== false && hasEmptyAnalysisTable(db, 'cfg_blocks')) {
    log('false: pending-analysis guard — cfg_blocks is empty');
    return false;
  }
  if (opts.dataflow !== false && hasEmptyAnalysisTable(db, 'dataflow')) {
    log('false: pending-analysis guard — dataflow is empty');
    return false;
  }
  return true;
}

/**
 * Read-only pre-flight check for the native orchestrator.
 *
 * Returns true iff every collected source file has matching mtime+size in
 * `file_hashes` and no DB-tracked file has been removed. When true, the
 * caller can short-circuit before invoking the native orchestrator —
 * matching WASM's ~20 ms early-exit path and avoiding the ~2s flat
 * per-call native rebuild overhead seen in CI (#1054).
 *
 * Intentionally Tier-0/Tier-1 only (journal + mtime/size). Tier-2 content
 * hashing is left to the native side: when this returns false the caller
 * falls through to the orchestrator, which performs its own complete
 * detection and is the source of truth.
 *
 * Conservatively returns false when CFG or dataflow analysis is enabled
 * but the corresponding tables are empty — otherwise the fast-skip would
 * silently suppress the pending-analysis pass that the JS path runs via
 * `runPendingAnalysis`, and CFG/dataflow data would never populate on
 * repos where source files don't change between builds.
 *
 * Pure read of `db` and the filesystem — never mutates either.
 *
 * `fastSkipDiag` gates the `[fast-skip]` diagnostic log lines and defaults to
 * `false` (matching `DEFAULTS.build.fastSkipDiag`) when the caller doesn't
 * have a resolved config value to pass — see `makeFastSkipLogger`.
 */
export function detectNoChanges(
  db: BetterSqlite3Database,
  allFiles: string[],
  rootDir: string,
  opts?: Record<string, unknown>,
  fastSkipDiag = false,
): boolean {
  const log = makeFastSkipLogger(fastSkipDiag);
  const existing = loadFileHashesForPreflight(db, log);
  if (!existing) return false;

  if (!allFilesMatchStoredStat(existing, allFiles, rootDir, log)) return false;
  if (!passesPendingAnalysisGuard(db, opts, log)) return false;

  log(`true: all checks passed (${allFiles.length} files)`);
  return true;
}

/**
 * Returns true if `table` exists and has zero rows, matching the empty-table
 * semantics of `runPendingAnalysis`. A missing table is treated as empty
 * (the conservative outcome), so the caller falls through to the orchestrator
 * which will create the schema and populate it.
 */
function hasEmptyAnalysisTable(db: BetterSqlite3Database, table: string): boolean {
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number } | undefined;
    return (row?.c ?? 0) === 0;
  } catch {
    return true;
  }
}

export async function detectChanges(ctx: PipelineContext): Promise<void> {
  const start = performance.now();
  try {
    const { db, allFiles, rootDir, incremental, forceFullRebuild, opts } = ctx;
    if ((opts as Record<string, unknown>).scope) {
      handleScopedBuild(ctx);
      return;
    }
    const increResult =
      incremental && !forceFullRebuild
        ? getChangedFiles(db, allFiles, rootDir)
        : {
            changed: allFiles.map((f): ChangedFile => ({ file: f })),
            removed: [] as string[],
            isFullBuild: true,
          };
    ctx.removed = increResult.removed;
    ctx.isFullBuild = increResult.isFullBuild;
    ctx.parseChanges = increResult.changed
      .filter((c) => !c.metadataOnly)
      .map((c) => ({
        file: c.file,
        relPath: c.relPath,
        content: c.content,
        hash: c.hash,
        stat: c.stat ? { mtime: c.stat.mtime, size: c.stat.size } : undefined,
        _reverseDepOnly: c._reverseDepOnly,
      }));
    ctx.metadataUpdates = increResult.changed
      .filter(
        (c): c is ChangedFile & { relPath: string; hash: string; stat: FileStat } =>
          !!c.metadataOnly && !!c.relPath && !!c.hash && !!c.stat,
      )
      .map((c) => ({
        relPath: c.relPath,
        hash: c.hash,
        stat: { mtime: c.stat.mtime, size: c.stat.size },
      }));
    if (!ctx.isFullBuild && ctx.parseChanges.length === 0 && ctx.removed.length === 0) {
      const ranAnalysis = await runPendingAnalysis(ctx);
      if (ranAnalysis) {
        closeDb(db);
        writeJournalHeader(rootDir, Date.now());
        ctx.earlyExit = true;
        return;
      }
      healMetadata(ctx);
      info('No changes detected. Graph is up to date.');
      closeDb(db);
      writeJournalHeader(rootDir, Date.now());
      ctx.earlyExit = true;
      return;
    }
    if (ctx.isFullBuild) {
      handleFullBuild(ctx);
    } else {
      handleIncrementalBuild(ctx);
    }
  } finally {
    // Additive to respect any partial detectMs contribution from collectFiles
    // (scoped-rebuild path splits change-detection outputs across both stages).
    ctx.timing.detectMs = (ctx.timing.detectMs ?? 0) + (performance.now() - start);
  }
}
