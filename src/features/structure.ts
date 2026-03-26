import path from 'node:path';
import { getNodeId, openReadonlyOrFail, testFilterSQL } from '../db/index.js';
import { loadConfig } from '../infrastructure/config.js';
import { debug } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { normalizePath } from '../shared/constants.js';
import { paginateResult } from '../shared/paginate.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../types.js';

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

function computeDirectoryMetrics(
  db: BetterSqlite3Database,
  upsertMetric: SqliteStatement,
  getNodeIdStmt: NodeIdStmt,
  fileSymbols: Map<string, FileSymbolData>,
  allDirs: Set<string>,
  importEdges: ImportEdge[],
): void {
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

  const fileToAncestorDirs = new Map<string, Set<string>>();
  for (const [dir, files] of dirFiles) {
    for (const f of files) {
      if (!fileToAncestorDirs.has(f)) fileToAncestorDirs.set(f, new Set());
      fileToAncestorDirs.get(f)?.add(dir);
    }
  }

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

  db.transaction(() => {
    for (const [dir, files] of dirFiles) {
      const dirRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
      if (!dirRow) continue;

      const fileCount = files.length;
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

function classifyNodeRolesFull(db: BetterSqlite3Database, emptySummary: RoleSummary): RoleSummary {
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
      WHERE n.kind NOT IN ('file', 'directory')`,
    )
    .all() as {
    id: number;
    name: string;
    kind: string;
    file: string;
    fan_in: number;
    fan_out: number;
  }[];

  if (rows.length === 0) return emptySummary;

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
  }));

  const roleMap = classifyRoles(classifierInput);

  // Build summary and group updates by role for batch UPDATE
  const summary: RoleSummary = { ...emptySummary };
  const idsByRole = new Map<string, number[]>();
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

  // Batch UPDATE: one statement per role instead of one per node
  const ROLE_CHUNK = 500;
  const roleStmtCache = new Map<number, SqliteStatement>();
  db.transaction(() => {
    db.prepare('UPDATE nodes SET role = NULL').run();
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

  // 2. Get affected nodes using indexed correlated subqueries (fast point lookups)
  const rows = db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.file,
        (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND target_id = n.id) AS fan_in,
        (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND source_id = n.id) AS fan_out
      FROM nodes n
      WHERE n.kind NOT IN ('file', 'directory')
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

  if (rows.length === 0) return emptySummary;

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
  const classifierInput = rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    kind: r.kind,
    file: r.file,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
    isExported: exportedIds.has(r.id),
    productionFanIn: prodFanInMap.get(r.id) || 0,
  }));

  const roleMap = classifyRoles(classifierInput, globalMedians);

  // 6. Build summary (only for affected nodes) and update only those nodes
  const summary: RoleSummary = { ...emptySummary };
  const idsByRole = new Map<string, number[]>();
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

  // Only update affected nodes — no global NULL reset
  const ROLE_CHUNK = 500;
  const roleStmtCache = new Map<number, SqliteStatement>();
  db.transaction(() => {
    // Reset roles only for affected files' nodes
    db.prepare(
      `UPDATE nodes SET role = NULL WHERE file IN (${placeholders}) AND kind NOT IN ('file', 'directory')`,
    ).run(...allAffectedFiles);
    for (const [role, ids] of idsByRole) {
      for (let i = 0; i < ids.length; i += ROLE_CHUNK) {
        const end = Math.min(i + ROLE_CHUNK, ids.length);
        const chunkSize = end - i;
        let stmt = roleStmtCache.get(chunkSize);
        if (!stmt) {
          const ph = Array.from({ length: chunkSize }, () => '?').join(',');
          stmt = db.prepare(`UPDATE nodes SET role = ? WHERE id IN (${ph})`);
          roleStmtCache.set(chunkSize, stmt);
        }
        const vals: unknown[] = [role];
        for (let j = i; j < end; j++) vals.push(ids[j]);
        stmt.run(...vals);
      }
    }
  })();

  return summary;
}

// ─── Query functions (read-only) ──────────────────────────────────────

interface DirRow {
  id: number;
  name: string;
  file: string;
  symbol_count: number | null;
  fan_in: number | null;
  fan_out: number | null;
  cohesion: number | null;
  file_count: number | null;
}

interface FileMetricRow {
  name: string;
  line_count: number | null;
  symbol_count: number | null;
  import_count: number | null;
  export_count: number | null;
  fan_in: number | null;
  fan_out: number | null;
}

interface StructureDataOpts {
  directory?: string;
  depth?: number;
  sort?: string;
  noTests?: boolean;
  full?: boolean;
  fileLimit?: number;
  limit?: number;
  offset?: number;
}

interface DirectoryEntry {
  directory: string;
  fileCount: number;
  symbolCount: number;
  fanIn: number;
  fanOut: number;
  cohesion: number | null;
  density: number;
  files: {
    file: string;
    lineCount: number;
    symbolCount: number;
    importCount: number;
    exportCount: number;
    fanIn: number;
    fanOut: number;
  }[];
  subdirectories: string[];
}

export function structureData(
  customDbPath?: string,
  opts: StructureDataOpts = {},
): {
  directories: DirectoryEntry[];
  count: number;
  suppressed?: number;
  warning?: string;
} {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const rawDir = opts.directory || null;
    const filterDir = rawDir && normalizePath(rawDir) !== '.' ? rawDir : null;
    const maxDepth = opts.depth || null;
    const sortBy = opts.sort || 'files';
    const noTests = opts.noTests || false;
    const full = opts.full || false;
    const fileLimit = opts.fileLimit || 25;

    // Get all directory nodes with their metrics
    let dirs = db
      .prepare(`
        SELECT n.id, n.name, n.file, nm.symbol_count, nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n
        LEFT JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'directory'
      `)
      .all() as DirRow[];

    if (filterDir) {
      const norm = normalizePath(filterDir);
      dirs = dirs.filter((d) => d.name === norm || d.name.startsWith(`${norm}/`));
    }

    if (maxDepth) {
      const baseDepth = filterDir ? normalizePath(filterDir).split('/').length : 0;
      dirs = dirs.filter((d) => {
        const depth = d.name.split('/').length - baseDepth;
        return depth <= maxDepth;
      });
    }

    // Sort
    const sortFn = getSortFn(sortBy);
    dirs.sort(sortFn);

    // Get file metrics for each directory
    const result: DirectoryEntry[] = dirs.map((d) => {
      let files = db
        .prepare(`
          SELECT n.name, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count, nm.fan_in, nm.fan_out
          FROM edges e
          JOIN nodes n ON e.target_id = n.id
          LEFT JOIN node_metrics nm ON n.id = nm.node_id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
        .all(d.id) as FileMetricRow[];
      if (noTests) files = files.filter((f) => !isTestFile(f.name));

      const subdirs = db
        .prepare(`
          SELECT n.name
          FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'directory'
        `)
        .all(d.id) as { name: string }[];

      const fileCount = noTests ? files.length : d.file_count || 0;
      return {
        directory: d.name,
        fileCount,
        symbolCount: d.symbol_count || 0,
        fanIn: d.fan_in || 0,
        fanOut: d.fan_out || 0,
        cohesion: d.cohesion,
        density: fileCount > 0 ? (d.symbol_count || 0) / fileCount : 0,
        files: files.map((f) => ({
          file: f.name,
          lineCount: f.line_count || 0,
          symbolCount: f.symbol_count || 0,
          importCount: f.import_count || 0,
          exportCount: f.export_count || 0,
          fanIn: f.fan_in || 0,
          fanOut: f.fan_out || 0,
        })),
        subdirectories: subdirs.map((s) => s.name),
      };
    });

    // Apply global file limit unless full mode
    if (!full) {
      const totalFiles = result.reduce((sum, d) => sum + d.files.length, 0);
      if (totalFiles > fileLimit) {
        let shown = 0;
        for (const d of result) {
          const remaining = fileLimit - shown;
          if (remaining <= 0) {
            d.files = [];
          } else if (d.files.length > remaining) {
            d.files = d.files.slice(0, remaining);
            shown = fileLimit;
          } else {
            shown += d.files.length;
          }
        }
        const suppressed = totalFiles - fileLimit;
        return {
          directories: result,
          count: result.length,
          suppressed,
          warning: `${suppressed} files omitted (showing ${fileLimit}/${totalFiles}). Use --full to show all files, or narrow with --directory.`,
        };
      }
    }

    const base = { directories: result, count: result.length };
    return paginateResult(base, 'directories', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

interface HotspotRow {
  name: string;
  kind: string;
  line_count: number | null;
  symbol_count: number | null;
  import_count: number | null;
  export_count: number | null;
  fan_in: number | null;
  fan_out: number | null;
  cohesion: number | null;
  file_count: number | null;
}

interface HotspotsDataOpts {
  metric?: string;
  level?: string;
  limit?: number;
  offset?: number;
  noTests?: boolean;
}

export function hotspotsData(
  customDbPath?: string,
  opts: HotspotsDataOpts = {},
): {
  metric: string;
  level: string;
  limit: number;
  hotspots: unknown[];
} {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const metric = opts.metric || 'fan-in';
    const level = opts.level || 'file';
    const limit = opts.limit || 10;
    const noTests = opts.noTests || false;

    const kind = level === 'directory' ? 'directory' : 'file';

    const testFilter = testFilterSQL('n.name', noTests && kind === 'file');

    const HOTSPOT_QUERIES: Record<string, { all(...params: unknown[]): HotspotRow[] }> = {
      'fan-in': db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY nm.fan_in DESC NULLS LAST LIMIT ?`),
      'fan-out': db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY nm.fan_out DESC NULLS LAST LIMIT ?`),
      density: db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY nm.symbol_count DESC NULLS LAST LIMIT ?`),
      coupling: db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY (COALESCE(nm.fan_in, 0) + COALESCE(nm.fan_out, 0)) DESC NULLS LAST LIMIT ?`),
    };

    const stmt = HOTSPOT_QUERIES[metric] ?? HOTSPOT_QUERIES['fan-in'];
    // stmt is always defined: metric is a valid key or the fallback is a concrete property
    const rows = stmt!.all(kind, limit);

    const hotspots = rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      lineCount: r.line_count,
      symbolCount: r.symbol_count,
      importCount: r.import_count,
      exportCount: r.export_count,
      fanIn: r.fan_in,
      fanOut: r.fan_out,
      cohesion: r.cohesion,
      fileCount: r.file_count,
      density:
        (r.file_count ?? 0) > 0
          ? (r.symbol_count || 0) / (r.file_count ?? 1)
          : (r.line_count ?? 0) > 0
            ? (r.symbol_count || 0) / (r.line_count ?? 1)
            : 0,
      coupling: (r.fan_in || 0) + (r.fan_out || 0),
    }));

    const base = { metric, level, limit, hotspots };
    return paginateResult(base, 'hotspots', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

interface ModuleBoundariesOpts {
  threshold?: number;
  config?: CodegraphConfig;
}

export function moduleBoundariesData(
  customDbPath?: string,
  opts: ModuleBoundariesOpts = {},
): {
  threshold: number;
  modules: {
    directory: string;
    cohesion: number | null;
    fileCount: number;
    symbolCount: number;
    fanIn: number;
    fanOut: number;
    files: string[];
  }[];
  count: number;
} {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const config = opts.config || loadConfig();
    const threshold =
      opts.threshold ??
      (config as unknown as { structure?: { cohesionThreshold?: number } }).structure
        ?.cohesionThreshold ??
      0.3;

    const dirs = db
      .prepare(`
        SELECT n.id, n.name, nm.symbol_count, nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n
        JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'directory' AND nm.cohesion IS NOT NULL AND nm.cohesion >= ?
        ORDER BY nm.cohesion DESC
      `)
      .all(threshold) as {
      id: number;
      name: string;
      symbol_count: number | null;
      fan_in: number | null;
      fan_out: number | null;
      cohesion: number | null;
      file_count: number | null;
    }[];

    const modules = dirs.map((d) => {
      // Get files inside this directory
      const files = (
        db
          .prepare(`
          SELECT n.name FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
          .all(d.id) as { name: string }[]
      ).map((f) => f.name);

      return {
        directory: d.name,
        cohesion: d.cohesion,
        fileCount: d.file_count || 0,
        symbolCount: d.symbol_count || 0,
        fanIn: d.fan_in || 0,
        fanOut: d.fan_out || 0,
        files,
      };
    });

    return { threshold, modules, count: modules.length };
  } finally {
    db.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getSortFn(sortBy: string): (a: DirRow, b: DirRow) => number {
  switch (sortBy) {
    case 'cohesion':
      return (a, b) => (b.cohesion ?? -1) - (a.cohesion ?? -1);
    case 'fan-in':
      return (a, b) => (b.fan_in || 0) - (a.fan_in || 0);
    case 'fan-out':
      return (a, b) => (b.fan_out || 0) - (a.fan_out || 0);
    case 'density':
      return (a, b) => {
        const da = (a.file_count ?? 0) > 0 ? (a.symbol_count || 0) / (a.file_count ?? 1) : 0;
        const db_ = (b.file_count ?? 0) > 0 ? (b.symbol_count || 0) / (b.file_count ?? 1) : 0;
        return db_ - da;
      };
    default:
      return (a, b) => a.name.localeCompare(b.name);
  }
}
