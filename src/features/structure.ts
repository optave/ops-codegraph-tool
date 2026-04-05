import path from 'node:path';
import { getNodeId, testFilterSQL } from '../db/index.js';
import { debug } from '../infrastructure/logger.js';
import { normalizePath } from '../shared/constants.js';
import type { BetterSqlite3Database } from '../types.js';

// ─── Build-time helpers ───────────────────────────────────────────────

interface NodeIdStmt {
  get(name: string, kind: string, file: string, line: number): { id: number } | undefined;
}

interface FileSymbolData {
  definitions: { name: string; kind: string; line: number }[];
  imports: unknown[];
  exports: unknown[];
  calls?: unknown[];
}

function getAncestorDirs(filePaths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const f of filePaths) {
    let d = normalizePath(path.dirname(f));
    while (d && d !== '.') {
      dirs.add(d);
      d = normalizePath(path.dirname(d));
    }
  }
  return dirs;
}

function cleanupPreviousData(
  db: BetterSqlite3Database,
  getNodeIdStmt: NodeIdStmt,
  isIncremental: boolean,
  changedFiles: string[] | null,
): void {
  if (isIncremental) {
    const affectedDirs = getAncestorDirs(changedFiles ?? []);
    const deleteContainsForDir = db.prepare(
      "DELETE FROM edges WHERE kind = 'contains' AND source_id IN (SELECT id FROM nodes WHERE name = ? AND kind = 'directory')",
    );
    const deleteMetricForNode = db.prepare('DELETE FROM node_metrics WHERE node_id = ?');
    db.transaction(() => {
      for (const dir of affectedDirs) {
        deleteContainsForDir.run(dir);
      }
      for (const f of changedFiles ?? []) {
        const fileRow = getNodeIdStmt.get(f, 'file', f, 0);
        if (fileRow) deleteMetricForNode.run(fileRow.id);
      }
      for (const dir of affectedDirs) {
        const dirRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
        if (dirRow) deleteMetricForNode.run(dirRow.id);
      }
    })();
  } else {
    db.exec(`
      DELETE FROM edges WHERE kind = 'contains'
        AND source_id IN (SELECT id FROM nodes WHERE kind = 'directory');
      DELETE FROM node_metrics;
      DELETE FROM nodes WHERE kind = 'directory';
    `);
  }
}

function collectAllDirectories(
  directories: Set<string> | Iterable<string>,
  fileSymbols: Map<string, FileSymbolData>,
): Set<string> {
  const allDirs = new Set<string>();
  for (const dir of directories) {
    let d = dir;
    while (d && d !== '.') {
      allDirs.add(d);
      d = normalizePath(path.dirname(d));
    }
  }
  for (const relPath of fileSymbols.keys()) {
    let d = normalizePath(path.dirname(relPath));
    while (d && d !== '.') {
      allDirs.add(d);
      d = normalizePath(path.dirname(d));
    }
  }
  return allDirs;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
}

function insertContainsEdges(
  db: BetterSqlite3Database,
  insertEdge: SqliteStatement,
  getNodeIdStmt: NodeIdStmt,
  fileSymbols: Map<string, FileSymbolData>,
  allDirs: Set<string>,
  changedFiles: string[] | null,
): void {
  const isIncremental = changedFiles != null && changedFiles.length > 0;
  const affectedDirs = isIncremental ? getAncestorDirs(changedFiles ?? []) : null;

  db.transaction(() => {
    for (const relPath of fileSymbols.keys()) {
      const dir = normalizePath(path.dirname(relPath));
      if (!dir || dir === '.') continue;
      if (affectedDirs && !affectedDirs.has(dir)) continue;
      const dirRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
      const fileRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
      if (dirRow && fileRow) {
        insertEdge.run(dirRow.id, fileRow.id, 'contains', 1.0, 0);
      }
    }
    for (const dir of allDirs) {
      const parent = normalizePath(path.dirname(dir));
      if (!parent || parent === '.' || parent === dir) continue;
      if (affectedDirs && !affectedDirs.has(parent)) continue;
      const parentRow = getNodeIdStmt.get(parent, 'directory', parent, 0);
      const childRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
      if (parentRow && childRow) {
        insertEdge.run(parentRow.id, childRow.id, 'contains', 1.0, 0);
      }
    }
  })();
}

interface ImportEdge {
  source_file: string;
  target_file: string;
}

function computeImportEdgeMaps(db: BetterSqlite3Database): {
  fanInMap: Map<string, number>;
  fanOutMap: Map<string, number>;
  importEdges: ImportEdge[];
} {
  const fanInMap = new Map<string, number>();
  const fanOutMap = new Map<string, number>();
  const importEdges = db
    .prepare(`
      SELECT n1.file AS source_file, n2.file AS target_file
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind IN ('imports', 'imports-type')
        AND n1.file != n2.file
    `)
    .all() as ImportEdge[];

  for (const { source_file, target_file } of importEdges) {
    fanOutMap.set(source_file, (fanOutMap.get(source_file) || 0) + 1);
    fanInMap.set(target_file, (fanInMap.get(target_file) || 0) + 1);
  }
  return { fanInMap, fanOutMap, importEdges };
}

function computeFileMetrics(
  db: BetterSqlite3Database,
  upsertMetric: SqliteStatement,
  getNodeIdStmt: NodeIdStmt,
  fileSymbols: Map<string, FileSymbolData>,
  lineCountMap: Map<string, number>,
  fanInMap: Map<string, number>,
  fanOutMap: Map<string, number>,
): void {
  db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const fileRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
      if (!fileRow) continue;

      const lineCount = lineCountMap.get(relPath) || 0;
      const seen = new Set<string>();
      let symbolCount = 0;
      for (const d of symbols.definitions) {
        const key = `${d.name}|${d.kind}|${d.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbolCount++;
        }
      }
      const importCount = symbols.imports.length;
      const exportCount = symbols.exports.length;
      const fanIn = fanInMap.get(relPath) || 0;
      const fanOut = fanOutMap.get(relPath) || 0;

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
}

/** Map each directory to the files it transitively contains. */
function buildDirFilesMap(
  allDirs: Set<string>,
  fileSymbols: Map<string, FileSymbolData>,
): Map<string, string[]> {
  const dirFiles = new Map<string, string[]>();
  for (const dir of allDirs) {
    dirFiles.set(dir, []);
  }
  for (const relPath of fileSymbols.keys()) {
    let d = normalizePath(path.dirname(relPath));
    while (d && d !== '.') {
      if (dirFiles.has(d)) {
        dirFiles.get(d)?.push(relPath);
      }
      d = normalizePath(path.dirname(d));
    }
  }
  return dirFiles;
}

/** Build reverse map: file -> set of ancestor directories. */
function buildFileToAncestorDirs(dirFiles: Map<string, string[]>): Map<string, Set<string>> {
  const fileToAncestorDirs = new Map<string, Set<string>>();
  for (const [dir, files] of dirFiles) {
    for (const f of files) {
      if (!fileToAncestorDirs.has(f)) fileToAncestorDirs.set(f, new Set());
      fileToAncestorDirs.get(f)?.add(dir);
    }
  }
  return fileToAncestorDirs;
}

/** Count intra-directory, fan-in, and fan-out edges per directory. */
function countDirectoryEdges(
  allDirs: Set<string>,
  importEdges: ImportEdge[],
  fileToAncestorDirs: Map<string, Set<string>>,
): Map<string, { intra: number; fanIn: number; fanOut: number }> {
  const dirEdgeCounts = new Map<string, { intra: number; fanIn: number; fanOut: number }>();
  for (const dir of allDirs) {
    dirEdgeCounts.set(dir, { intra: 0, fanIn: 0, fanOut: 0 });
  }
  for (const { source_file, target_file } of importEdges) {
    const srcDirs = fileToAncestorDirs.get(source_file);
    const tgtDirs = fileToAncestorDirs.get(target_file);
    if (!srcDirs && !tgtDirs) continue;

    if (srcDirs) {
      for (const dir of srcDirs) {
        const counts = dirEdgeCounts.get(dir);
        if (!counts) continue;
        if (tgtDirs?.has(dir)) {
          counts.intra++;
        } else {
          counts.fanOut++;
        }
      }
    }
    if (tgtDirs) {
      for (const dir of tgtDirs) {
        if (srcDirs?.has(dir)) continue;
        const counts = dirEdgeCounts.get(dir);
        if (!counts) continue;
        counts.fanIn++;
      }
    }
  }
  return dirEdgeCounts;
}

/** Count unique symbols in a list of files. */
function countSymbolsInFiles(files: string[], fileSymbols: Map<string, FileSymbolData>): number {
  let symbolCount = 0;
  for (const f of files) {
    const sym = fileSymbols.get(f);
    if (sym) {
      const seen = new Set<string>();
      for (const d of sym.definitions) {
        const key = `${d.name}|${d.kind}|${d.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbolCount++;
        }
      }
    }
  }
  return symbolCount;
}

function computeDirectoryMetrics(
  db: BetterSqlite3Database,
  upsertMetric: SqliteStatement,
  getNodeIdStmt: NodeIdStmt,
  fileSymbols: Map<string, FileSymbolData>,
  allDirs: Set<string>,
  importEdges: ImportEdge[],
): void {
  const dirFiles = buildDirFilesMap(allDirs, fileSymbols);
  const fileToAncestorDirs = buildFileToAncestorDirs(dirFiles);
  const dirEdgeCounts = countDirectoryEdges(allDirs, importEdges, fileToAncestorDirs);

  db.transaction(() => {
    for (const [dir, files] of dirFiles) {
      const dirRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
      if (!dirRow) continue;

      const fileCount = files.length;
      const symbolCount = countSymbolsInFiles(files, fileSymbols);

      const counts = dirEdgeCounts.get(dir) || { intra: 0, fanIn: 0, fanOut: 0 };
      const totalEdges = counts.intra + counts.fanIn + counts.fanOut;
      const cohesion = totalEdges > 0 ? counts.intra / totalEdges : null;

      upsertMetric.run(
        dirRow.id,
        null,
        symbolCount,
        null,
        null,
        counts.fanIn,
        counts.fanOut,
        cohesion,
        fileCount,
      );
    }
  })();
}

// ─── Build-time: insert directory nodes, contains edges, and metrics ────

export function buildStructure(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, FileSymbolData>,
  _rootDir: string,
  lineCountMap: Map<string, number>,
  directories: Set<string>,
  changedFiles?: string[] | null,
): void {
  const insertNode = db.prepare(
    'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
  );
  const getNodeIdStmt: NodeIdStmt = {
    get: (name: string, kind: string, file: string, line: number) => {
      const id = getNodeId(db, name, kind, file, line);
      return id != null ? { id } : undefined;
    },
  };
  const insertEdge = db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
  );
  const upsertMetric = db.prepare(`
    INSERT OR REPLACE INTO node_metrics
      (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out, cohesion, file_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const isIncremental = changedFiles != null && changedFiles.length > 0;

  cleanupPreviousData(db, getNodeIdStmt, isIncremental, changedFiles ?? null);

  const allDirs = collectAllDirectories(directories, fileSymbols);

  db.transaction(() => {
    for (const dir of allDirs) {
      insertNode.run(dir, 'directory', dir, 0, null);
    }
  })();

  insertContainsEdges(db, insertEdge, getNodeIdStmt, fileSymbols, allDirs, changedFiles ?? null);

  const { fanInMap, fanOutMap, importEdges } = computeImportEdgeMaps(db);

  computeFileMetrics(
    db,
    upsertMetric,
    getNodeIdStmt,
    fileSymbols,
    lineCountMap,
    fanInMap,
    fanOutMap,
  );

  computeDirectoryMetrics(db, upsertMetric, getNodeIdStmt, fileSymbols, allDirs, importEdges);

  debug(`Structure: ${allDirs.size} directories, ${fileSymbols.size} files with metrics`);
}

// ─── Node role classification ─────────────────────────────────────────

// Re-export from classifier for backward compatibility
export { FRAMEWORK_ENTRY_PREFIXES } from '../graph/classifiers/roles.js';

import { classifyRoles, median } from '../graph/classifiers/roles.js';

interface RoleSummary {
  entry: number;
  core: number;
  utility: number;
  adapter: number;
  dead: number;
  'dead-leaf': number;
  'dead-entry': number;
  'dead-ffi': number;
  'dead-unresolved': number;
  'test-only': number;
  leaf: number;
  [key: string]: number;
}

/**
 * Classify every node in the graph into a role (core, entry, utility, etc.).
 *
 * When `changedFiles` is provided, only nodes from those files (and their
 * edge neighbours) are reclassified. The returned `RoleSummary` in that case
 * reflects **only the affected subset**, not the entire graph. Callers that
 * need graph-wide totals should perform a full classification (omit
 * `changedFiles`) or query the DB directly.
 */
export function classifyNodeRoles(
  db: BetterSqlite3Database,
  changedFiles?: string[] | null,
): RoleSummary {
  const emptySummary: RoleSummary = {
    entry: 0,
    core: 0,
    utility: 0,
    adapter: 0,
    dead: 0,
    'dead-leaf': 0,
    'dead-entry': 0,
    'dead-ffi': 0,
    'dead-unresolved': 0,
    'test-only': 0,
    leaf: 0,
  };

  // Incremental path: only reclassify nodes from affected files
  if (changedFiles && changedFiles.length > 0) {
    return classifyNodeRolesIncremental(db, changedFiles, emptySummary);
  }

  return classifyNodeRolesFull(db, emptySummary);
}

// ─── Shared role-classification helpers ───────────────────────────────

/**
 * Build a role summary and group node IDs by role from classifier output.
 * Shared between full and incremental classification paths.
 */
function buildRoleSummary(
  rows: { id: number }[],
  leafRows: { id: number }[],
  roleMap: Map<string, string>,
  emptySummary: RoleSummary,
): { summary: RoleSummary; idsByRole: Map<string, number[]> } {
  const summary: RoleSummary = { ...emptySummary };
  const idsByRole = new Map<string, number[]>();

  // Leaf kinds are always dead-leaf — skip classifier
  if (leafRows.length > 0) {
    const leafIds: number[] = [];
    for (const row of leafRows) leafIds.push(row.id);
    idsByRole.set('dead-leaf', leafIds);
    summary.dead += leafRows.length;
    summary['dead-leaf'] += leafRows.length;
  }

  for (const row of rows) {
    const role = roleMap.get(String(row.id)) || 'leaf';
    if (role.startsWith('dead')) summary.dead++;
    summary[role] = (summary[role] || 0) + 1;
    let ids = idsByRole.get(role);
    if (!ids) {
      ids = [];
      idsByRole.set(role, ids);
    }
    ids.push(row.id);
  }

  return { summary, idsByRole };
}

/**
 * Batch-update node roles in the database. Executes a reset callback
 * first (full resets all nodes, incremental resets only affected files),
 * then writes new roles in chunks.
 */
function batchUpdateRoles(
  db: BetterSqlite3Database,
  idsByRole: Map<string, number[]>,
  resetFn: () => void,
): void {
  const ROLE_CHUNK = 500;
  const roleStmtCache = new Map<number, SqliteStatement>();
  db.transaction(() => {
    resetFn();
    for (const [role, ids] of idsByRole) {
      for (let i = 0; i < ids.length; i += ROLE_CHUNK) {
        const end = Math.min(i + ROLE_CHUNK, ids.length);
        const chunkSize = end - i;
        let stmt = roleStmtCache.get(chunkSize);
        if (!stmt) {
          const placeholders = Array.from({ length: chunkSize }, () => '?').join(',');
          stmt = db.prepare(`UPDATE nodes SET role = ? WHERE id IN (${placeholders})`);
          roleStmtCache.set(chunkSize, stmt);
        }
        const vals: unknown[] = [role];
        for (let j = i; j < end; j++) vals.push(ids[j]);
        stmt.run(...vals);
      }
    }
  })();
}

function classifyNodeRolesFull(db: BetterSqlite3Database, emptySummary: RoleSummary): RoleSummary {
  // Leaf kinds (parameter, property) can never have callers/callees.
  // Classify them directly as dead-leaf without the expensive fan-in/fan-out JOINs.
  const leafRows = db
    .prepare(
      `SELECT n.id
      FROM nodes n
      WHERE n.kind IN ('parameter', 'property')`,
    )
    .all() as { id: number }[];

  // Only compute fan-in/fan-out for callable/classifiable nodes
  const rows = db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.file,
        COALESCE(fi.cnt, 0) AS fan_in,
        COALESCE(fo.cnt, 0) AS fan_out
      FROM nodes n
      LEFT JOIN (
        SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id
      ) fi ON n.id = fi.target_id
      LEFT JOIN (
        SELECT source_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id
      ) fo ON n.id = fo.source_id
      WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')`,
    )
    .all() as {
    id: number;
    name: string;
    kind: string;
    file: string;
    fan_in: number;
    fan_out: number;
  }[];

  if (rows.length === 0 && leafRows.length === 0) return emptySummary;

  const exportedIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT e.target_id
        FROM edges e
        JOIN nodes caller ON e.source_id = caller.id
        JOIN nodes target ON e.target_id = target.id
        WHERE e.kind = 'calls' AND caller.file != target.file`,
        )
        .all() as { target_id: number }[]
    ).map((r) => r.target_id),
  );

  // Compute production fan-in (excluding callers in test files)
  const prodFanInMap = new Map<number, number>();
  const prodRows = db
    .prepare(
      `SELECT e.target_id, COUNT(*) AS cnt
      FROM edges e
      JOIN nodes caller ON e.source_id = caller.id
      WHERE e.kind = 'calls'
        ${testFilterSQL('caller.file')}
      GROUP BY e.target_id`,
    )
    .all() as { target_id: number; cnt: number }[];
  for (const r of prodRows) {
    prodFanInMap.set(r.target_id, r.cnt);
  }

  // Files with at least one callable (non-constant) connected to the graph.
  // Constants in these files are likely consumed locally via identifier reference.
  const activeFiles = new Set<string>();
  for (const r of rows) {
    if ((r.fan_in > 0 || r.fan_out > 0) && r.kind !== 'constant') {
      activeFiles.add(r.file);
    }
  }

  // Delegate classification to the pure-logic classifier
  const classifierInput = rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    kind: r.kind,
    file: r.file,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
    isExported: exportedIds.has(r.id),
    productionFanIn: prodFanInMap.get(r.id) || 0,
    hasActiveFileSiblings: r.kind === 'constant' ? activeFiles.has(r.file) : undefined,
  }));

  const roleMap = classifyRoles(classifierInput);

  const { summary, idsByRole } = buildRoleSummary(rows, leafRows, roleMap, emptySummary);

  batchUpdateRoles(db, idsByRole, () => {
    db.prepare('UPDATE nodes SET role = NULL').run();
  });

  return summary;
}

/**
 * Incremental role classification: only reclassify nodes from changed files
 * plus their immediate edge neighbours (callers and callees in other files).
 *
 * Uses indexed point lookups for fan-in/fan-out instead of full table scans.
 * Global medians are computed from edge distribution (fast GROUP BY on index).
 * Unchanged files not connected to changed files keep their roles from the
 * previous build.
 */
function classifyNodeRolesIncremental(
  db: BetterSqlite3Database,
  changedFiles: string[],
  emptySummary: RoleSummary,
): RoleSummary {
  // Expand affected set: include files containing nodes that are edge neighbours
  // of changed-file nodes. This ensures that removing a call from file A to a
  // node in file B causes B's roles to be recalculated (fan_in changed).
  const seedPlaceholders = changedFiles.map(() => '?').join(',');
  const neighbourFiles = db
    .prepare(
      `SELECT DISTINCT n2.file FROM edges e
       JOIN nodes n1 ON (e.source_id = n1.id OR e.target_id = n1.id)
       JOIN nodes n2 ON (e.source_id = n2.id OR e.target_id = n2.id)
       WHERE e.kind = 'calls'
         AND n1.file IN (${seedPlaceholders})
         AND n2.file NOT IN (${seedPlaceholders})
         AND n2.kind NOT IN ('file', 'directory')`,
    )
    .all(...changedFiles, ...changedFiles) as { file: string }[];
  const allAffectedFiles = [...changedFiles, ...neighbourFiles.map((r) => r.file)];
  const placeholders = allAffectedFiles.map(() => '?').join(',');

  // 1. Compute global medians from edge distribution (fast: scans edge index, no node join)
  const fanInDist = (
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id`)
      .all() as { cnt: number }[]
  )
    .map((r) => r.cnt)
    .sort((a, b) => a - b);
  const fanOutDist = (
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id`)
      .all() as { cnt: number }[]
  )
    .map((r) => r.cnt)
    .sort((a, b) => a - b);

  const globalMedians = { fanIn: median(fanInDist), fanOut: median(fanOutDist) };

  // 2a. Leaf kinds (parameter, property) in affected files — always dead-leaf
  const leafRows = db
    .prepare(
      `SELECT n.id FROM nodes n
      WHERE n.kind IN ('parameter', 'property')
        AND n.file IN (${placeholders})`,
    )
    .all(...allAffectedFiles) as { id: number }[];

  // 2b. Get callable nodes using indexed correlated subqueries (fast point lookups)
  const rows = db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.file,
        (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND target_id = n.id) AS fan_in,
        (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND source_id = n.id) AS fan_out
      FROM nodes n
      WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')
        AND n.file IN (${placeholders})`,
    )
    .all(...allAffectedFiles) as {
    id: number;
    name: string;
    kind: string;
    file: string;
    fan_in: number;
    fan_out: number;
  }[];

  if (rows.length === 0 && leafRows.length === 0) return emptySummary;

  // 3. Get exported status for affected nodes only (scoped to changed files)
  const exportedIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT e.target_id
          FROM edges e
          JOIN nodes caller ON e.source_id = caller.id
          JOIN nodes target ON e.target_id = target.id
          WHERE e.kind = 'calls' AND caller.file != target.file
            AND target.file IN (${placeholders})`,
        )
        .all(...allAffectedFiles) as { target_id: number }[]
    ).map((r) => r.target_id),
  );

  // 4. Production fan-in for affected nodes only
  const prodFanInMap = new Map<number, number>();
  const prodRows = db
    .prepare(
      `SELECT e.target_id, COUNT(*) AS cnt
      FROM edges e
      JOIN nodes caller ON e.source_id = caller.id
      JOIN nodes target ON e.target_id = target.id
      WHERE e.kind = 'calls'
        AND target.file IN (${placeholders})
        ${testFilterSQL('caller.file')}
      GROUP BY e.target_id`,
    )
    .all(...allAffectedFiles) as { target_id: number; cnt: number }[];
  for (const r of prodRows) {
    prodFanInMap.set(r.target_id, r.cnt);
  }

  // 5. Classify affected nodes using global medians
  const activeFiles = new Set<string>();
  for (const r of rows) {
    if ((r.fan_in > 0 || r.fan_out > 0) && r.kind !== 'constant') {
      activeFiles.add(r.file);
    }
  }

  const classifierInput = rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    kind: r.kind,
    file: r.file,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
    isExported: exportedIds.has(r.id),
    productionFanIn: prodFanInMap.get(r.id) || 0,
    hasActiveFileSiblings: r.kind === 'constant' ? activeFiles.has(r.file) : undefined,
  }));

  const roleMap = classifyRoles(classifierInput, globalMedians);

  // 6. Build summary (only for affected nodes) and update only those nodes
  const { summary, idsByRole } = buildRoleSummary(rows, leafRows, roleMap, emptySummary);

  batchUpdateRoles(db, idsByRole, () => {
    // Reset roles only for affected files' nodes
    db.prepare(
      `UPDATE nodes SET role = NULL WHERE file IN (${placeholders}) AND kind NOT IN ('file', 'directory')`,
    ).run(...allAffectedFiles);
  });

  return summary;
}

// ─── Query functions (re-exported from structure-query.ts) ────────────
// Split to separate query-time concerns (DB reads, sorting, pagination)
// from build-time concerns (directory insertion, metrics computation, role classification).
export { hotspotsData, moduleBoundariesData, structureData } from './structure-query.js';
