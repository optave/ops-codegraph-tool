/**
 * Stage: detectChanges
 *
 * Three-tier change detection cascade + incremental reverse-dependency handling.
 * Sets ctx.parseChanges, ctx.metadataUpdates, ctx.removed, ctx.isFullBuild, ctx.earlyExit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from '../../../../constants.js';
import { closeDb } from '../../../../db/index.js';
import { readJournal, writeJournalHeader } from '../../../../journal.js';
import { debug, info } from '../../../../logger.js';
import { parseFilesAuto } from '../../../../parser.js';
import { fileHash, fileStat, purgeFilesFromGraph, readFileSafe } from '../helpers.js';

/**
 * Determine which files have changed since last build.
 * Three-tier cascade:
 *   Tier 0 — Journal: O(changed) when watcher was running
 *   Tier 1 — mtime+size: O(n) stats, O(changed) reads
 *   Tier 2 — Hash comparison: O(changed) reads (fallback from Tier 1)
 */
function getChangedFiles(db, allFiles, rootDir) {
  let hasTable = false;
  try {
    db.prepare('SELECT 1 FROM file_hashes LIMIT 1').get();
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

  const existing = new Map(
    db
      .prepare('SELECT file, hash, mtime, size FROM file_hashes')
      .all()
      .map((r) => [r.file, r]),
  );

  const currentFiles = new Set();
  for (const file of allFiles) {
    currentFiles.add(normalizePath(path.relative(rootDir, file)));
  }

  const removed = [];
  for (const existingFile of existing.keys()) {
    if (!currentFiles.has(existingFile)) {
      removed.push(existingFile);
    }
  }

  // ── Tier 0: Journal ──────────────────────────────────────────────
  const journal = readJournal(rootDir);
  if (journal.valid) {
    const dbMtimes = db.prepare('SELECT MAX(mtime) as latest FROM file_hashes').get();
    const latestDbMtime = dbMtimes?.latest || 0;
    const hasJournalEntries = journal.changed.length > 0 || journal.removed.length > 0;

    if (hasJournalEntries && journal.timestamp >= latestDbMtime) {
      debug(
        `Tier 0: journal valid, ${journal.changed.length} changed, ${journal.removed.length} removed`,
      );
      const changed = [];

      for (const relPath of journal.changed) {
        const absPath = path.join(rootDir, relPath);
        const stat = fileStat(absPath);
        if (!stat) continue;

        let content;
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
      for (const relPath of journal.removed) {
        if (existing.has(relPath)) removedSet.add(relPath);
      }

      return { changed, removed: [...removedSet], isFullBuild: false };
    }
    debug(
      `Tier 0: skipped (${hasJournalEntries ? 'timestamp stale' : 'no entries'}), falling to Tier 1`,
    );
  }

  // ── Tier 1: mtime+size fast-path ─────────────────────────────────
  const needsHash = [];
  const skipped = [];

  for (const file of allFiles) {
    const relPath = normalizePath(path.relative(rootDir, file));
    const record = existing.get(relPath);

    if (!record) {
      needsHash.push({ file, relPath });
      continue;
    }

    const stat = fileStat(file);
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

  // ── Tier 2: Hash comparison ──────────────────────────────────────
  const changed = [];

  for (const item of needsHash) {
    let content;
    try {
      content = readFileSafe(item.file);
    } catch {
      continue;
    }
    const hash = fileHash(content);
    const stat = item.stat || fileStat(item.file);
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

/**
 * Run pending analysis pass when no file changes but analysis tables are empty.
 * @returns {boolean} true if analysis was run and we should early-exit
 */
async function runPendingAnalysis(ctx) {
  const { db, opts, engineOpts, allFiles, rootDir } = ctx;

  const needsCfg =
    opts.cfg !== false &&
    (() => {
      try {
        return db.prepare('SELECT COUNT(*) as c FROM cfg_blocks').get().c === 0;
      } catch {
        return true;
      }
    })();
  const needsDataflow =
    opts.dataflow !== false &&
    (() => {
      try {
        return db.prepare('SELECT COUNT(*) as c FROM dataflow').get().c === 0;
      } catch {
        return true;
      }
    })();

  if (!needsCfg && !needsDataflow) return false;

  info('No file changes. Running pending analysis pass...');
  const analysisOpts = {
    ...engineOpts,
    dataflow: needsDataflow && opts.dataflow !== false,
  };
  const analysisSymbols = await parseFilesAuto(allFiles, rootDir, analysisOpts);
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

/**
 * Self-heal metadata-only updates (mtime/size) without re-parsing.
 */
function healMetadata(ctx) {
  const { db, metadataUpdates } = ctx;
  if (!metadataUpdates || metadataUpdates.length === 0) return;
  try {
    const healHash = db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
    const healTx = db.transaction(() => {
      for (const item of metadataUpdates) {
        const mtime = item.stat ? Math.floor(item.stat.mtimeMs) : 0;
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

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function detectChanges(ctx) {
  const { db, allFiles, rootDir, incremental, forceFullRebuild, opts } = ctx;

  // Scoped builds already set parseChanges in collectFiles.
  // Still need to purge removed files and set hasEmbeddings.
  if (opts.scope) {
    let hasEmbeddings = false;
    try {
      db.prepare('SELECT 1 FROM embeddings LIMIT 1').get();
      hasEmbeddings = true;
    } catch {
      /* table doesn't exist */
    }
    ctx.hasEmbeddings = hasEmbeddings;

    // Reverse-dependency cascade BEFORE purging (needs existing edges to find importers)
    const changePaths = ctx.parseChanges.map(
      (item) => item.relPath || normalizePath(path.relative(rootDir, item.file)),
    );
    const reverseDeps = new Set();
    if (!opts.noReverseDeps) {
      const changedRelPaths = new Set([...changePaths, ...ctx.removed]);
      if (changedRelPaths.size > 0) {
        const findReverseDeps = db.prepare(`
          SELECT DISTINCT n_src.file FROM edges e
          JOIN nodes n_src ON e.source_id = n_src.id
          JOIN nodes n_tgt ON e.target_id = n_tgt.id
          WHERE n_tgt.file = ? AND n_src.file != n_tgt.file AND n_src.kind != 'directory'
        `);
        for (const relPath of changedRelPaths) {
          for (const row of findReverseDeps.all(relPath)) {
            if (!changedRelPaths.has(row.file) && !reverseDeps.has(row.file)) {
              const absPath = path.join(rootDir, row.file);
              if (fs.existsSync(absPath)) {
                reverseDeps.add(row.file);
              }
            }
          }
        }
      }
    }

    // Now purge changed + removed files
    if (changePaths.length > 0 || ctx.removed.length > 0) {
      purgeFilesFromGraph(db, [...ctx.removed, ...changePaths], { purgeHashes: false });
    }

    // Delete outgoing edges for reverse-dep files and add to parse list
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
      info(
        `Scoped rebuild: ${changePaths.length} changed, ${ctx.removed.length} removed, ${reverseDeps.size} reverse-deps`,
      );
    }
    return;
  }

  const increResult =
    incremental && !forceFullRebuild
      ? getChangedFiles(db, allFiles, rootDir)
      : { changed: allFiles.map((f) => ({ file: f })), removed: [], isFullBuild: true };

  ctx.removed = increResult.removed;
  ctx.isFullBuild = increResult.isFullBuild;
  ctx.parseChanges = increResult.changed.filter((c) => !c.metadataOnly);
  ctx.metadataUpdates = increResult.changed.filter((c) => c.metadataOnly);

  // Early exit: no changes detected
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

  // ── Full build: truncate all tables ──────────────────────────────
  let hasEmbeddings = false;
  try {
    db.prepare('SELECT 1 FROM embeddings LIMIT 1').get();
    hasEmbeddings = true;
  } catch {
    /* table doesn't exist */
  }
  ctx.hasEmbeddings = hasEmbeddings;

  if (ctx.isFullBuild) {
    const deletions =
      'PRAGMA foreign_keys = OFF; DELETE FROM cfg_edges; DELETE FROM cfg_blocks; DELETE FROM node_metrics; DELETE FROM edges; DELETE FROM function_complexity; DELETE FROM dataflow; DELETE FROM ast_nodes; DELETE FROM nodes; PRAGMA foreign_keys = ON;';
    db.exec(
      hasEmbeddings
        ? `${deletions.replace('PRAGMA foreign_keys = ON;', '')} DELETE FROM embeddings; PRAGMA foreign_keys = ON;`
        : deletions,
    );
    return;
  }

  // ── Reverse-dependency cascade (incremental) ─────────────────────
  const reverseDeps = new Set();
  if (!opts.noReverseDeps) {
    const changedRelPaths = new Set();
    for (const item of ctx.parseChanges) {
      changedRelPaths.add(item.relPath || normalizePath(path.relative(rootDir, item.file)));
    }
    for (const relPath of ctx.removed) {
      changedRelPaths.add(relPath);
    }

    if (changedRelPaths.size > 0) {
      const findReverseDeps = db.prepare(`
        SELECT DISTINCT n_src.file FROM edges e
        JOIN nodes n_src ON e.source_id = n_src.id
        JOIN nodes n_tgt ON e.target_id = n_tgt.id
        WHERE n_tgt.file = ? AND n_src.file != n_tgt.file AND n_src.kind != 'directory'
      `);
      for (const relPath of changedRelPaths) {
        for (const row of findReverseDeps.all(relPath)) {
          if (!changedRelPaths.has(row.file) && !reverseDeps.has(row.file)) {
            const absPath = path.join(rootDir, row.file);
            if (fs.existsSync(absPath)) {
              reverseDeps.add(row.file);
            }
          }
        }
      }
    }
  }

  info(
    `Incremental: ${ctx.parseChanges.length} changed, ${ctx.removed.length} removed${reverseDeps.size > 0 ? `, ${reverseDeps.size} reverse-deps` : ''}`,
  );
  if (ctx.parseChanges.length > 0)
    debug(`Changed files: ${ctx.parseChanges.map((c) => c.relPath).join(', ')}`);
  if (ctx.removed.length > 0) debug(`Removed files: ${ctx.removed.join(', ')}`);

  // Purge changed and removed files
  const changePaths = ctx.parseChanges.map(
    (item) => item.relPath || normalizePath(path.relative(rootDir, item.file)),
  );
  purgeFilesFromGraph(db, [...ctx.removed, ...changePaths], { purgeHashes: false });

  // Delete outgoing edges for reverse-dep files, then add them to parse list
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
