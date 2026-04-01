/**
 * Stage: collectFiles
 *
 * Collects all source files to process. Handles both normal and scoped rebuilds.
 * For incremental builds with a valid journal, reconstructs the file list from
 * the DB's file_hashes table + journal deltas, skipping the filesystem scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { debug, info } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
import { readJournal } from '../../journal.js';
import type { PipelineContext } from '../context.js';
import { collectFiles as collectFilesUtil } from '../helpers.js';

/**
 * Reconstruct allFiles from DB file_hashes + journal deltas.
 * Returns null when the fast path isn't applicable (first build, no journal, etc).
 */
function tryFastCollect(
  ctx: PipelineContext,
): { files: string[]; directories: Set<string> } | null {
  const { db, rootDir } = ctx;
  const useNative = ctx.engineName === 'native' && !!ctx.nativeDb?.getCollectFilesData;

  // 1. Check that file_hashes table exists and has entries
  let dbFileCount: number;
  let dbFiles: string[];
  if (useNative) {
    const data = ctx.nativeDb!.getCollectFilesData!();
    dbFileCount = data.count;
    dbFiles = data.files;
  } else {
    try {
      dbFileCount = (db.prepare('SELECT COUNT(*) as c FROM file_hashes').get() as { c: number }).c;
    } catch {
      return null;
    }
    dbFiles = []; // deferred — loaded below only if needed
  }
  if (dbFileCount === 0) return null;

  // 2. Read the journal — only use fast path when journal has entries,
  // proving the watcher was active and tracking changes. An empty-but-valid
  // journal (no watcher) could miss file deletions.
  const journal = readJournal(rootDir);
  if (!journal.valid) return null;
  const hasEntries =
    (journal.changed && journal.changed.length > 0) ||
    (journal.removed && journal.removed.length > 0);
  if (!hasEntries) return null;

  // 3. Load existing file list from file_hashes (relative paths)
  if (!useNative) {
    dbFiles = (db.prepare('SELECT file FROM file_hashes').all() as Array<{ file: string }>).map(
      (r) => r.file,
    );
  }

  // 4. Apply journal deltas: remove deleted files, add new/changed files
  const fileSet = new Set(dbFiles);
  if (journal.removed) {
    for (const removed of journal.removed) {
      fileSet.delete(removed);
    }
  }
  if (journal.changed) {
    for (const changed of journal.changed) {
      fileSet.add(changed);
    }
  }

  // 5. Convert to absolute paths and compute directories
  const files: string[] = [];
  const directories = new Set<string>();
  for (const relPath of fileSet) {
    const absPath = path.join(rootDir, relPath);
    files.push(absPath);
    directories.add(path.dirname(absPath));
  }

  debug(
    `collectFiles fast path: ${dbFiles.length} from DB, journal: +${journal.changed?.length ?? 0}/-${journal.removed?.length ?? 0} → ${files.length} files`,
  );
  return { files, directories };
}

export async function collectFiles(ctx: PipelineContext): Promise<void> {
  const { rootDir, config, opts } = ctx;

  if (opts.scope) {
    // Scoped rebuild: rebuild only specified files
    const scopedFiles = opts.scope.map((f: string) => normalizePath(f));
    const existing: Array<{ file: string; relPath: string }> = [];
    const missing: string[] = [];
    for (const rel of scopedFiles) {
      const abs = path.join(rootDir, rel);
      if (fs.existsSync(abs)) {
        existing.push({ file: abs, relPath: rel });
      } else {
        missing.push(rel);
      }
    }
    ctx.allFiles = existing.map((e) => e.file);
    ctx.discoveredDirs = new Set(existing.map((e) => path.dirname(e.file)));
    ctx.parseChanges = existing;
    ctx.metadataUpdates = [];
    ctx.removed = missing;
    ctx.isFullBuild = false;
    info(`Scoped rebuild: ${existing.length} files to rebuild, ${missing.length} to purge`);
    return;
  }

  // Incremental fast path: reconstruct file list from DB + journal deltas
  // instead of full recursive filesystem scan (~8ms savings on 473 files).
  if (ctx.incremental && !ctx.forceFullRebuild) {
    const fast = tryFastCollect(ctx);
    if (fast) {
      ctx.allFiles = fast.files;
      ctx.discoveredDirs = fast.directories;
      info(`Found ${ctx.allFiles.length} files (cached)`);
      return;
    }
  }

  const collected = collectFilesUtil(rootDir, [], config, new Set<string>());
  ctx.allFiles = collected.files;
  ctx.discoveredDirs = collected.directories;
  info(`Found ${ctx.allFiles.length} files to parse`);
}
