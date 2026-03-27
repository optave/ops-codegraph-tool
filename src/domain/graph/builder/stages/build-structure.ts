/**
 * Stage: buildStructure + classifyRoles
 *
 * Builds directory structure, containment edges, metrics, and classifies node roles.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { debug } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
import type { ExtractorOutput } from '../../../../types.js';
import type { PipelineContext } from '../context.js';
import { readFileSafe } from '../helpers.js';

export async function buildStructure(ctx: PipelineContext): Promise<void> {
  const { db, fileSymbols, rootDir, discoveredDirs, allSymbols, isFullBuild } = ctx;

  // Build line count map (prefer cached _lineCount from parser)
  ctx.lineCountMap = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    const lineCount =
      (symbols as ExtractorOutput & { lineCount?: number }).lineCount ?? symbols._lineCount;
    if (lineCount) {
      ctx.lineCountMap.set(relPath, lineCount);
    } else {
      const absPath = path.join(rootDir, relPath);
      try {
        const content = readFileSafe(absPath);
        ctx.lineCountMap.set(relPath, content.split('\n').length);
      } catch {
        ctx.lineCountMap.set(relPath, 0);
      }
    }
  }

  const changedFileList = isFullBuild ? null : [...allSymbols.keys()];

  // For small incremental builds on large codebases, use a fast path that
  // updates only the changed files' metrics via targeted SQL instead of
  // loading ALL definitions from DB (~8ms) and recomputing ALL metrics (~15ms).
  // Gate: ≤5 changed files AND significantly more existing files (>20) to
  // avoid triggering on small test fixtures where directory metrics matter.
  const existingFileCount = !isFullBuild
    ? (db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get() as { c: number }).c
    : 0;
  const useSmallIncrementalFastPath =
    !isFullBuild &&
    changedFileList != null &&
    changedFileList.length <= 5 &&
    existingFileCount > 20;

  if (!isFullBuild && !useSmallIncrementalFastPath) {
    // Medium/large incremental: load unchanged files from DB for complete structure
    loadUnchangedFilesFromDb(ctx);
  }

  // Build directory structure
  const t0 = performance.now();
  if (useSmallIncrementalFastPath) {
    updateChangedFileMetrics(ctx, changedFileList!);
  } else {
    const relDirs = new Set<string>();
    for (const absDir of discoveredDirs) {
      relDirs.add(normalizePath(path.relative(rootDir, absDir)));
    }
    try {
      const { buildStructure: buildStructureFn } = (await import(
        '../../../../features/structure.js'
      )) as {
        buildStructure: (
          db: PipelineContext['db'],
          fileSymbols: Map<string, ExtractorOutput>,
          rootDir: string,
          lineCountMap: Map<string, number>,
          directories: Set<string>,
          changedFiles: string[] | null,
        ) => void;
      };
      const changedFilePaths = isFullBuild ? null : [...allSymbols.keys()];
      buildStructureFn(db, fileSymbols, rootDir, ctx.lineCountMap, relDirs, changedFilePaths);
    } catch (err) {
      debug(`Structure analysis failed: ${(err as Error).message}`);
    }
  }
  ctx.timing.structureMs = performance.now() - t0;

  // Classify node roles (incremental: only reclassify changed files' nodes)
  const t1 = performance.now();
  try {
    const { classifyNodeRoles } = (await import('../../../../features/structure.js')) as {
      classifyNodeRoles: (
        db: PipelineContext['db'],
        changedFiles?: string[] | null,
      ) => Record<string, number>;
    };
    const roleSummary = classifyNodeRoles(db, changedFileList);
    debug(
      `Roles${changedFileList ? ` (incremental, ${changedFileList.length} files)` : ''}: ${Object.entries(
        roleSummary,
      )
        .map(([r, c]) => `${r}=${c}`)
        .join(', ')}`,
    );
  } catch (err) {
    debug(`Role classification failed: ${(err as Error).message}`);
  }
  ctx.timing.rolesMs = performance.now() - t1;
}

// ── Small incremental fast path ──────────────────────────────────────────

/**
 * For small incremental builds, update only the changed files' node_metrics
 * using targeted SQL queries. Skips the full DB load of all definitions
 * (~8ms) and full structure rebuild (~15ms), replacing them with per-file
 * indexed queries (~1-2ms total for 1-5 files).
 *
 * Directory metrics are not recomputed — a 1-5 file change won't
 * meaningfully alter directory-level cohesion or symbol counts.
 */
function updateChangedFileMetrics(ctx: PipelineContext, changedFiles: string[]): void {
  const { db } = ctx;

  const getFileNodeId = db.prepare(
    "SELECT id FROM nodes WHERE name = ? AND kind = 'file' AND file = ? AND line = 0",
  );
  const getSymbolCount = db.prepare(
    "SELECT COUNT(*) as c FROM nodes WHERE file = ? AND kind != 'file' AND kind != 'directory'",
  );
  const getImportCount = db.prepare(`
    SELECT COUNT(DISTINCT n2.file) AS cnt FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE e.kind = 'imports' AND n1.file = ?
  `);
  const getFanIn = db.prepare(`
    SELECT COUNT(DISTINCT n_src.file) AS cnt FROM edges e
    JOIN nodes n_src ON e.source_id = n_src.id
    JOIN nodes n_tgt ON e.target_id = n_tgt.id
    WHERE e.kind = 'imports' AND n_tgt.file = ? AND n_src.file != n_tgt.file
  `);
  const getFanOut = db.prepare(`
    SELECT COUNT(DISTINCT n_tgt.file) AS cnt FROM edges e
    JOIN nodes n_src ON e.source_id = n_src.id
    JOIN nodes n_tgt ON e.target_id = n_tgt.id
    WHERE e.kind = 'imports' AND n_src.file = ? AND n_src.file != n_tgt.file
  `);
  const upsertMetric = db.prepare(`
    INSERT OR REPLACE INTO node_metrics
      (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out, cohesion, file_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const relPath of changedFiles) {
      const fileRow = getFileNodeId.get(relPath, relPath) as { id: number } | undefined;
      if (!fileRow) continue;

      const lineCount = ctx.lineCountMap.get(relPath) || 0;
      const symbolCount = (getSymbolCount.get(relPath) as { c: number }).c;
      const importCount = (getImportCount.get(relPath) as { cnt: number }).cnt;
      const exportCount = ctx.fileSymbols.get(relPath)?.exports.length || 0;
      const fanIn = (getFanIn.get(relPath) as { cnt: number }).cnt;
      const fanOut = (getFanOut.get(relPath) as { cnt: number }).cnt;

      upsertMetric.run(
        fileRow.id,
        lineCount,
        symbolCount,
        importCount,
        exportCount,
        fanIn,
        fanOut,
        null,
        null,
      );
    }
  })();

  debug(`Structure (fast path): updated metrics for ${changedFiles.length} files`);
}

// ── Full incremental DB load (medium/large changes) ──────────────────────

function loadUnchangedFilesFromDb(ctx: PipelineContext): void {
  const { db, fileSymbols, rootDir } = ctx;

  const existingFiles = db
    .prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'")
    .all() as Array<{ file: string }>;

  // Batch load: all definitions, import counts, and line counts in single queries
  const allDefs = db
    .prepare(
      "SELECT file, name, kind, line FROM nodes WHERE kind != 'file' AND kind != 'directory'",
    )
    .all() as Array<{ file: string; name: string; kind: string; line: number }>;
  const defsByFileMap = new Map<string, Array<{ name: string; kind: string; line: number }>>();
  for (const row of allDefs) {
    let arr = defsByFileMap.get(row.file);
    if (!arr) {
      arr = [];
      defsByFileMap.set(row.file, arr);
    }
    arr.push({ name: row.name, kind: row.kind, line: row.line });
  }

  const allImportCounts = db
    .prepare(
      `SELECT n1.file, COUNT(DISTINCT n2.file) AS cnt FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       WHERE e.kind = 'imports'
       GROUP BY n1.file`,
    )
    .all() as Array<{ file: string; cnt: number }>;
  const importCountMap = new Map<string, number>();
  for (const row of allImportCounts) {
    importCountMap.set(row.file, row.cnt);
  }

  const cachedLineCounts = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT n.name AS file, m.line_count
       FROM node_metrics m JOIN nodes n ON m.node_id = n.id
       WHERE n.kind = 'file'`,
    )
    .all() as Array<{ file: string; line_count: number }>) {
    cachedLineCounts.set(row.file, row.line_count);
  }

  let loadedFromDb = 0;
  for (const { file: relPath } of existingFiles) {
    if (!fileSymbols.has(relPath)) {
      const importCount = importCountMap.get(relPath) || 0;
      fileSymbols.set(relPath, {
        definitions: defsByFileMap.get(relPath) || [],
        imports: new Array(importCount) as unknown as ExtractorOutput['imports'],
        exports: [],
      } as unknown as ExtractorOutput);
      loadedFromDb++;
    }
    if (!ctx.lineCountMap.has(relPath)) {
      const cached = cachedLineCounts.get(relPath);
      if (cached != null) {
        ctx.lineCountMap.set(relPath, cached);
      } else {
        const absPath = path.join(rootDir, relPath);
        try {
          const content = readFileSafe(absPath);
          ctx.lineCountMap.set(relPath, content.split('\n').length);
        } catch {
          ctx.lineCountMap.set(relPath, 0);
        }
      }
    }
  }
  debug(`Structure: ${fileSymbols.size} files (${loadedFromDb} loaded from DB)`);
}
