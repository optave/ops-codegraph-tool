/**
 * Stage: detectChanges
 *
 * Determines which files have changed since the last build using a tiered
 * strategy: journal → mtime+size → content hash.  Handles full, incremental,
 * and scoped rebuilds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDb } from '../../../../db/index.js';
import { debug, info } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
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
  mtimeMs: number;
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
  nativeDb?: NativeDatabase,
): ChangeResult {
  let hasTable = false;
  try {
    if (nativeDb) {
      nativeDb.queryGet('SELECT 1 FROM file_hashes LIMIT 1', []);
    } else {
      db.prepare('SELECT 1 FROM file_hashes LIMIT 1').get();
    }
    // Query succeeded → table exists (result may be undefined if table is empty)
    hasTable = true;
  } catch {
    /* table doesn't exist */
  }

  if (!hasTable) {
    return {
      changed: allFiles.map((f) => ({ file: f })),
      removed: [],
      isFullBuild: true,
    };
  }

  const sql = 'SELECT file, hash, mtime, size FROM file_hashes';
  const rows = nativeDb
    ? (nativeDb.queryAll(sql, []) as unknown as FileHashRow[])
    : (db.prepare(sql).all() as FileHashRow[]);
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
): ChangeResult | null {
  const journal = readJournal(rootDir);
  if (!journal.valid) return null;

  const dbMtimes = db.prepare('SELECT MAX(mtime) as latest FROM file_hashes').get() as
    | { latest: number | null }
    | undefined;
  const latestDbMtime = dbMtimes?.latest || 0;
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

function mtimeAndHashTiers(
  existing: Map<string, FileHashRow>,
  allFiles: string[],
  rootDir: string,
  removed: string[],
): ChangeResult {
  const needsHash: NeedsHashItem[] = [];
  const skipped: string[] = [];

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
    if (storedSize > 0 && Math.floor(stat.mtimeMs) === storedMtime && stat.size === storedSize) {
      skipped.push(relPath);
      continue;
    }
    needsHash.push({ file, relPath, stat });
  }

  if (needsHash.length > 0) {
    debug(`Tier 1: ${skipped.length} skipped by mtime+size, ${needsHash.length} need hash check`);
  }

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

  const parseChanged = changed.filter((c) => !c.metadataOnly);
  if (needsHash.length > 0) {
    debug(
      `Tier 2: ${parseChanged.length} actually changed, ${changed.length - parseChanged.length} metadata-only`,
    );
  }

  return { changed, removed, isFullBuild: false };
}

async function runPendingAnalysis(ctx: PipelineContext): Promise<boolean> {
  const { db, opts, engineOpts, allFiles, rootDir } = ctx;
  const needsCfg =
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
  const needsDataflow =
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
  if (needsCfg) {
    const { buildCFGData } = await import('../../../../features/cfg.js');
    await buildCFGData(db, analysisSymbols, rootDir, engineOpts);
  }
  if (needsDataflow) {
    const { buildDataflowEdges } = await import('../../../../features/dataflow.js');
    await buildDataflowEdges(db, analysisSymbols, rootDir, engineOpts);
  }
  return true;
}

function healMetadata(ctx: PipelineContext): void {
  const { db, metadataUpdates } = ctx;
  if (!metadataUpdates || metadataUpdates.length === 0) return;
  try {
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
    debug(`Self-healed mtime/size for ${metadataUpdates.length} files`);
  } catch {
    /* ignore heal errors */
  }
}

function findReverseDependencies(
  db: BetterSqlite3Database,
  changedRelPaths: Set<string>,
  rootDir: string,
): Set<string> {
  const reverseDeps = new Set<string>();
  if (changedRelPaths.size === 0) return reverseDeps;
  const findReverseDepsStmt = db.prepare(`
    SELECT DISTINCT n_src.file FROM edges e
    JOIN nodes n_src ON e.source_id = n_src.id
    JOIN nodes n_tgt ON e.target_id = n_tgt.id
    WHERE n_tgt.file = ? AND n_src.file != n_tgt.file AND n_src.kind != 'directory'
  `);
  for (const relPath of changedRelPaths) {
    for (const row of findReverseDepsStmt.all(relPath) as Array<{ file: string }>) {
      if (!changedRelPaths.has(row.file) && !reverseDeps.has(row.file)) {
        const absPath = path.join(rootDir, row.file);
        if (fs.existsSync(absPath)) {
          reverseDeps.add(row.file);
        }
      }
    }
  }
  return reverseDeps;
}

function purgeAndAddReverseDeps(
  ctx: PipelineContext,
  changePaths: string[],
  reverseDeps: Set<string>,
): void {
  const { db, rootDir } = ctx;
  if (changePaths.length > 0 || ctx.removed.length > 0) {
    const filesToPurge = [...ctx.removed, ...changePaths];
    // Prefer NativeDatabase persistent connection for purge (6.15)
    if (ctx.nativeDb?.purgeFilesData) {
      ctx.nativeDb.purgeFilesData(filesToPurge, false);
    } else {
      purgeFilesFromGraph(db, filesToPurge, { purgeHashes: false });
    }
  }
  if (reverseDeps.size > 0) {
    const deleteOutgoingEdgesForFile = db.prepare(
      'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    );
    for (const relPath of reverseDeps) {
      deleteOutgoingEdgesForFile.run(relPath);
    }
    for (const relPath of reverseDeps) {
      const absPath = path.join(rootDir, relPath);
      ctx.parseChanges.push({ file: absPath, relPath, _reverseDepOnly: true });
    }
  }
}

function detectHasEmbeddings(db: BetterSqlite3Database): boolean {
  try {
    db.prepare('SELECT 1 FROM embeddings LIMIT 1').get();
    return true;
  } catch {
    return false;
  }
}

function handleScopedBuild(ctx: PipelineContext): void {
  const { db, rootDir, opts } = ctx;
  ctx.hasEmbeddings = detectHasEmbeddings(db);
  const changePaths = ctx.parseChanges.map(
    (item) => item.relPath || normalizePath(path.relative(rootDir, item.file)),
  );
  let reverseDeps = new Set<string>();
  if (!(opts as Record<string, unknown>).noReverseDeps) {
    const changedRelPaths = new Set<string>([...changePaths, ...ctx.removed]);
    reverseDeps = findReverseDependencies(db, changedRelPaths, rootDir);
  }
  purgeAndAddReverseDeps(ctx, changePaths, reverseDeps);
  info(
    `Scoped rebuild: ${changePaths.length} changed, ${ctx.removed.length} removed, ${reverseDeps.size} reverse-deps`,
  );
}

function handleFullBuild(ctx: PipelineContext): void {
  const { db } = ctx;
  const hasEmbeddings = detectHasEmbeddings(db);
  ctx.hasEmbeddings = hasEmbeddings;
  const deletions =
    'PRAGMA foreign_keys = OFF; DELETE FROM cfg_edges; DELETE FROM cfg_blocks; DELETE FROM node_metrics; DELETE FROM edges; DELETE FROM function_complexity; DELETE FROM dataflow; DELETE FROM ast_nodes; DELETE FROM nodes; PRAGMA foreign_keys = ON;';
  db.exec(
    hasEmbeddings
      ? `${deletions.replace('PRAGMA foreign_keys = ON;', '')} DELETE FROM embeddings; PRAGMA foreign_keys = ON;`
      : deletions,
  );
}

function handleIncrementalBuild(ctx: PipelineContext): void {
  const { db, rootDir, opts } = ctx;
  ctx.hasEmbeddings = detectHasEmbeddings(db);
  let reverseDeps = new Set<string>();
  if (!(opts as Record<string, unknown>).noReverseDeps) {
    const changedRelPaths = new Set<string>();
    for (const item of ctx.parseChanges) {
      changedRelPaths.add(item.relPath || normalizePath(path.relative(rootDir, item.file)));
    }
    for (const relPath of ctx.removed) {
      changedRelPaths.add(relPath);
    }
    reverseDeps = findReverseDependencies(db, changedRelPaths, rootDir);
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
  purgeAndAddReverseDeps(ctx, changePaths, reverseDeps);
}

export async function detectChanges(ctx: PipelineContext): Promise<void> {
  const { db, allFiles, rootDir, incremental, forceFullRebuild, opts } = ctx;
  if ((opts as Record<string, unknown>).scope) {
    handleScopedBuild(ctx);
    return;
  }
  const increResult =
    incremental && !forceFullRebuild
      ? getChangedFiles(db, allFiles, rootDir, ctx.nativeDb)
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
      stat: c.stat ? { mtime: Math.floor(c.stat.mtimeMs), size: c.stat.size } : undefined,
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
      stat: { mtime: Math.floor(c.stat.mtimeMs), size: c.stat.size },
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
}
