/**
 * Stage: buildStructure + classifyRoles
 *
 * Builds directory structure, containment edges, metrics, and classifies node roles.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { debug } from '../../../../infrastructure/logger.js';
import { getAncestorDirs, normalizePath } from '../../../../shared/constants.js';
import type { ExtractorOutput } from '../../../../types.js';
import type { PipelineContext } from '../context.js';
import { readFileSafe } from '../helpers.js';

/** Populate `ctx.lineCountMap` from cached parser results, falling back to disk. */
function populateLineCountMap(ctx: PipelineContext): void {
  const { fileSymbols, rootDir } = ctx;
  ctx.lineCountMap = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    const lineCount =
      (symbols as ExtractorOutput & { lineCount?: number }).lineCount ?? symbols._lineCount;
    if (lineCount) {
      ctx.lineCountMap.set(relPath, lineCount);
      continue;
    }
    const absPath = path.join(rootDir, relPath);
    try {
      const content = readFileSafe(absPath);
      ctx.lineCountMap.set(relPath, content.split('\n').length);
    } catch {
      ctx.lineCountMap.set(relPath, 0);
    }
  }
}

/** Count file-kind nodes already in the DB, preferring the native connection. */
function countExistingFiles(ctx: PipelineContext): number {
  const useNativeReads = ctx.engineName === 'native' && !!ctx.nativeDb;
  const row = (
    useNativeReads
      ? ctx.nativeDb!.queryGet("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'", [])
      : ctx.db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get()
  ) as { c: number };
  return row.c;
}

/**
 * Build directory structure + metrics. Chooses between the fast incremental
 * path (a handful of files changed on a large codebase) and the full path
 * (delegated to `features/structure`).
 */
async function buildDirectoryStructure(
  ctx: PipelineContext,
  changedFileList: string[] | null,
  useSmallIncrementalFastPath: boolean,
): Promise<void> {
  if (useSmallIncrementalFastPath) {
    updateChangedFileMetrics(ctx, changedFileList!);
    refreshAffectedDirectoryMetrics(
      ctx,
      changedFileList!,
      ctx.removed ?? [],
      ctx.removedFileNeighbors ?? [],
    );
    return;
  }

  const { db, fileSymbols, rootDir, discoveredDirs, allSymbols, isFullBuild } = ctx;
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

/** Convert a `NativeDatabase.classifyRoles*` result into the JS summary shape. */
function nativeRoleSummaryToRecord(
  nativeResult: NonNullable<
    ReturnType<NonNullable<PipelineContext['nativeDb']>['classifyRolesFull']>
  >,
): Record<string, number> {
  return {
    entry: nativeResult.entry,
    core: nativeResult.core,
    utility: nativeResult.utility,
    adapter: nativeResult.adapter,
    dead: nativeResult.dead,
    'dead-leaf': nativeResult.deadLeaf,
    'dead-entry': nativeResult.deadEntry,
    'dead-ffi': nativeResult.deadFfi,
    'dead-unresolved': nativeResult.deadUnresolved,
    'test-only': nativeResult.testOnly,
    leaf: nativeResult.leaf,
  };
}

async function classifyRoles(
  ctx: PipelineContext,
  changedFileList: string[] | null,
): Promise<void> {
  const useNativeReads = ctx.engineName === 'native' && !!ctx.nativeDb;
  try {
    let roleSummary: Record<string, number> | null = null;

    // Use NativeDatabase persistent connection (Phase 6.15+).
    // Standalone napi functions were removed in 6.17 — falls through to JS if nativeDb unavailable.
    // Note: classifyRoles* both read (fan-in/fan-out) and write (UPDATE nodes SET role).
    if (useNativeReads && ctx.nativeDb?.classifyRolesFull) {
      const nativeResult =
        changedFileList && changedFileList.length > 0
          ? ctx.nativeDb.classifyRolesIncremental(changedFileList)
          : ctx.nativeDb.classifyRolesFull();
      if (nativeResult) roleSummary = nativeRoleSummaryToRecord(nativeResult);
    }

    if (!roleSummary) {
      const { classifyNodeRoles } = (await import('../../../../features/structure.js')) as {
        classifyNodeRoles: (
          db: PipelineContext['db'],
          changedFiles?: string[] | null,
        ) => Record<string, number>;
      };
      roleSummary = classifyNodeRoles(ctx.db, changedFileList);
    }

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
}

export async function buildStructure(ctx: PipelineContext): Promise<void> {
  const { allSymbols, isFullBuild } = ctx;

  populateLineCountMap(ctx);

  const changedFileList = isFullBuild ? null : [...allSymbols.keys()];

  // For small incremental builds on large codebases, use a fast path that
  // updates only the changed files' metrics via targeted SQL instead of
  // loading ALL definitions from DB (~8ms) and recomputing ALL metrics (~15ms).
  // Gate: ≤smallFilesThreshold changed files AND significantly more existing files (>20) to
  // avoid triggering on small test fixtures where directory metrics matter.
  const existingFileCount = !isFullBuild ? countExistingFiles(ctx) : 0;
  const useSmallIncrementalFastPath =
    !isFullBuild &&
    changedFileList != null &&
    changedFileList.length <= ctx.config.build.smallFilesThreshold &&
    existingFileCount > 20;

  if (!isFullBuild && !useSmallIncrementalFastPath) {
    loadUnchangedFilesFromDb(ctx);
  }

  const t0 = performance.now();
  await buildDirectoryStructure(ctx, changedFileList, useSmallIncrementalFastPath);
  ctx.timing.structureMs = performance.now() - t0;

  const t1 = performance.now();
  await classifyRoles(ctx, changedFileList);
  ctx.timing.rolesMs = performance.now() - t1;
}

// ── Small incremental fast path ──────────────────────────────────────────

/**
 * For small incremental builds, update only the changed files' node_metrics
 * using targeted SQL queries. Skips the full DB load of all definitions
 * (~8ms) and full structure rebuild (~15ms), replacing them with per-file
 * indexed queries (~1-2ms total for 1-5 files).
 *
 * Directory-level metrics are handled separately by
 * `refreshAffectedDirectoryMetrics` below — this function only ever touches
 * per-file rows.
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
    WHERE e.kind IN ('imports', 'imports-type') AND n_tgt.file = ? AND n_src.file != n_tgt.file
  `);
  const getFanOut = db.prepare(`
    SELECT COUNT(DISTINCT n_tgt.file) AS cnt FROM edges e
    JOIN nodes n_src ON e.source_id = n_src.id
    JOIN nodes n_tgt ON e.target_id = n_tgt.id
    WHERE e.kind IN ('imports', 'imports-type') AND n_src.file = ? AND n_src.file != n_tgt.file
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

/**
 * Targeted directory-metrics refresh for the small-incremental fast path.
 *
 * `updateChangedFileMetrics` only ever touches per-file `node_metrics` rows —
 * it never looks at directories. Any file added to, removed from, or edited
 * within a directory left that directory's fileCount/symbolCount/fanIn/
 * fanOut/cohesion stale until the next full rebuild (#1738), and a file added
 * under a brand-new directory never even got a directory node or a `contains`
 * edge from its parent.
 *
 * This recomputes metrics for the ancestor directories of the files that
 * changed in this build (added, removed, or modified), PLUS any directory
 * reachable from them via a live cross-directory import edge — a changed
 * file that gains (or loses) an import into a sibling package shifts that
 * package's fan-in/fan-out/cohesion even though none of its own files were
 * touched. One level of expansion only (mirrors the neighbour-expansion
 * `classifyNodeRolesIncremental` already does for role classification) —
 * bounded by (changed files × path depth) rather than the size of the repo,
 * so it stays cheap enough to run unconditionally alongside the fast path.
 *
 * Removed files need no edge/node cleanup of their own — `purgeFilesData`
 * already deleted their nodes and every edge referencing them (including
 * their old `contains` edge) earlier in the pipeline; only their ancestor
 * directories' aggregates need recomputing here. A removed file's own
 * cross-directory neighbors (files it imported, or that imported it) can no
 * longer be discovered from LIVE edges by the time this runs — those edges
 * are already purged — so `detectChanges` captures them up front, before the
 * purge, and passes them in as `removedFileNeighbors` (#1839).
 */
function refreshAffectedDirectoryMetrics(
  ctx: PipelineContext,
  changedFiles: string[],
  removedFiles: string[],
  removedFileNeighbors: string[],
): void {
  const { db } = ctx;
  const affectedDirs = getAncestorDirs([...changedFiles, ...removedFiles, ...removedFileNeighbors]);
  if (affectedDirs.size === 0) return;

  const getDirId = db.prepare(
    "SELECT id FROM nodes WHERE name = ? AND kind = 'directory' AND file = ? AND line = 0",
  );
  // Directories connected to `dir` via a live import/imports-type edge in
  // either direction — the cross-directory neighbours whose own fan-in/out
  // may have shifted even though none of their files changed.
  const neighborFiles = db.prepare(`
    SELECT n2.file AS other FROM edges e 
      JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind IN ('imports', 'imports-type') AND n1.file != n2.file
        AND n1.file >= @lo AND n1.file < @hi
    UNION
    SELECT n1.file AS other FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind IN ('imports', 'imports-type') AND n1.file != n2.file
        AND n2.file >= @lo AND n2.file < @hi
  `);
  for (const dir of [...affectedDirs]) {
    const otherFiles = neighborFiles.all({ lo: `${dir}/`, hi: `${dir}0` }) as Array<{
      other: string;
    }>;
    for (const ancestor of getAncestorDirs(otherFiles.map((r) => r.other))) {
      affectedDirs.add(ancestor);
    }
  }

  const insertDirNode = db.prepare(
    'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
  );
  const getFileId = db.prepare(
    "SELECT id FROM nodes WHERE name = ? AND kind = 'file' AND file = ? AND line = 0",
  );
  const insertContainsIfMissing = db.prepare(`
    INSERT INTO edges (source_id, target_id, kind, confidence, dynamic)
    SELECT ?, ?, 'contains', 1.0, 0
    WHERE NOT EXISTS (
      SELECT 1 FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'contains'
    )
  `);
  // fileCount/symbolCount: transitive counts under `dir`, matching
  // computeDirectoryMetrics in features/structure.ts. `file >= dir/ AND
  // file < dir0` is an index-friendly prefix-range scan equivalent to
  // `file LIKE 'dir/%'` — '0' (0x30) is the character immediately after
  // '/' (0x2F), so this bound matches exactly the paths nested under `dir`.
  const countFiles = db.prepare(
    "SELECT COUNT(*) AS c FROM nodes WHERE kind = 'file' AND file >= ? AND file < ?",
  );
  const countSymbols = db.prepare(
    "SELECT COUNT(*) AS c FROM nodes WHERE kind != 'file' AND kind != 'directory' AND file >= ? AND file < ?",
  );
  // Edges sourced from a file inside dir: intra (target also inside dir) vs fan-out.
  const outboundEdges = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN n2.file >= @lo AND n2.file < @hi THEN 1 ELSE 0 END), 0) AS intra,
      COUNT(*) AS total
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE e.kind IN ('imports', 'imports-type')
      AND n1.file != n2.file
      AND n2.kind = 'file'
      AND n1.file >= @lo AND n1.file < @hi
  `);
  // Edges targeting a file inside dir, sourced from a file outside dir (fan-in only).
  const inboundEdges = db.prepare(`
    SELECT COUNT(*) AS c
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE e.kind IN ('imports', 'imports-type')
      AND n1.file != n2.file
      AND n2.kind = 'file'
      AND n2.file >= @lo AND n2.file < @hi
      AND NOT (n1.file >= @lo AND n1.file < @hi)
  `);
  const upsertMetric = db.prepare(`
    INSERT OR REPLACE INTO node_metrics
      (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out, cohesion, file_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    // Ensure directory nodes exist for the whole affected ancestor chain —
    // handles a file added under a brand-new (possibly multi-level) directory.
    for (const dir of affectedDirs) {
      insertDirNode.run(dir, 'directory', dir, 0, null);
    }

    // Wire dir -> parent-dir contains edges for the chain.
    for (const dir of affectedDirs) {
      const parent = normalizePath(path.dirname(dir));
      if (!parent || parent === '.' || parent === dir) continue;
      const parentRow = getDirId.get(parent, parent) as { id: number } | undefined;
      const childRow = getDirId.get(dir, dir) as { id: number } | undefined;
      if (parentRow && childRow) {
        insertContainsIfMissing.run(parentRow.id, childRow.id, parentRow.id, childRow.id);
      }
    }

    // Wire dir -> file contains edges for changed (added/modified) files.
    // Removed files' nodes and edges are already purged upstream.
    for (const relPath of changedFiles) {
      const dir = normalizePath(path.dirname(relPath));
      if (!dir || dir === '.') continue;
      const dirRow = getDirId.get(dir, dir) as { id: number } | undefined;
      const fileRow = getFileId.get(relPath, relPath) as { id: number } | undefined;
      if (dirRow && fileRow) {
        insertContainsIfMissing.run(dirRow.id, fileRow.id, dirRow.id, fileRow.id);
      }
    }

    // Recompute each affected directory's metrics from the live DB state.
    for (const dir of affectedDirs) {
      const dirRow = getDirId.get(dir, dir) as { id: number } | undefined;
      if (!dirRow) continue;

      const lo = `${dir}/`;
      const hi = `${dir}0`;
      const fileCount = (countFiles.get(lo, hi) as { c: number }).c;
      const symbolCount = (countSymbols.get(lo, hi) as { c: number }).c;
      const out = outboundEdges.get({ lo, hi }) as { intra: number; total: number };
      const fanOut = out.total - out.intra;
      const fanIn = (inboundEdges.get({ lo, hi }) as { c: number }).c;
      const totalEdges = out.intra + fanIn + fanOut;
      const cohesion = totalEdges > 0 ? out.intra / totalEdges : null;

      upsertMetric.run(
        dirRow.id,
        null,
        symbolCount,
        null,
        null,
        fanIn,
        fanOut,
        cohesion,
        fileCount,
      );
    }
  })();

  debug(
    `Structure (fast path): refreshed metrics for ${affectedDirs.size} affected director${affectedDirs.size === 1 ? 'y' : 'ies'}`,
  );
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
