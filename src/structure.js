import path from 'node:path';
import { normalizePath } from './constants.js';
import { getNodeId, openReadonlyOrFail, testFilterSQL } from './db.js';
import { isTestFile } from './infrastructure/test-filter.js';
import { debug } from './logger.js';
import { paginateResult } from './paginate.js';

// ─── Build-time: insert directory nodes, contains edges, and metrics ────

/**
 * Build directory structure nodes, containment edges, and compute metrics.
 * Called from builder.js after edge building.
 *
 * @param {import('better-sqlite3').Database} db - Open read-write database
 * @param {Map<string, object>} fileSymbols - Map of relPath → { definitions, imports, exports, calls }
 * @param {string} rootDir - Absolute root directory
 * @param {Map<string, number>} lineCountMap - Map of relPath → line count
 * @param {Set<string>} directories - Set of relative directory paths
 */
export function buildStructure(db, fileSymbols, _rootDir, lineCountMap, directories, changedFiles) {
  const insertNode = db.prepare(
    'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
  );
  const getNodeIdStmt = {
    get: (name, kind, file, line) => {
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

  if (isIncremental) {
    // Incremental: only clean up data for changed files and their ancestor directories
    const affectedDirs = new Set();
    for (const f of changedFiles) {
      let d = normalizePath(path.dirname(f));
      while (d && d !== '.') {
        affectedDirs.add(d);
        d = normalizePath(path.dirname(d));
      }
    }
    const deleteContainsForDir = db.prepare(
      "DELETE FROM edges WHERE kind = 'contains' AND source_id IN (SELECT id FROM nodes WHERE name = ? AND kind = 'directory')",
    );
    const deleteMetricForNode = db.prepare('DELETE FROM node_metrics WHERE node_id = ?');
    db.transaction(() => {
      // Delete contains edges only from affected directories
      for (const dir of affectedDirs) {
        deleteContainsForDir.run(dir);
      }
      // Delete metrics for changed files
      for (const f of changedFiles) {
        const fileRow = getNodeIdStmt.get(f, 'file', f, 0);
        if (fileRow) deleteMetricForNode.run(fileRow.id);
      }
      // Delete metrics for affected directories
      for (const dir of affectedDirs) {
        const dirRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
        if (dirRow) deleteMetricForNode.run(dirRow.id);
      }
    })();
  } else {
    // Full rebuild: clean previous directory nodes/edges (idempotent)
    // Scope contains-edge delete to directory-sourced edges only,
    // preserving symbol-level contains edges (file→def, class→method, etc.)
    db.exec(`
      DELETE FROM edges WHERE kind = 'contains'
        AND source_id IN (SELECT id FROM nodes WHERE kind = 'directory');
      DELETE FROM node_metrics;
      DELETE FROM nodes WHERE kind = 'directory';
    `);
  }

  // Step 1: Ensure all directories are represented (including intermediate parents)
  const allDirs = new Set();
  for (const dir of directories) {
    let d = dir;
    while (d && d !== '.') {
      allDirs.add(d);
      d = normalizePath(path.dirname(d));
    }
  }
  // Also add dirs derived from file paths
  for (const relPath of fileSymbols.keys()) {
    let d = normalizePath(path.dirname(relPath));
    while (d && d !== '.') {
      allDirs.add(d);
      d = normalizePath(path.dirname(d));
    }
  }

  // Step 2: Insert directory nodes (INSERT OR IGNORE — safe for incremental)
  const insertDirs = db.transaction(() => {
    for (const dir of allDirs) {
      insertNode.run(dir, 'directory', dir, 0, null);
    }
  });
  insertDirs();

  // Step 3: Insert 'contains' edges (dir → file, dir → subdirectory)
  // On incremental, only re-insert for affected directories (others are intact)
  const affectedDirs = isIncremental
    ? (() => {
        const dirs = new Set();
        for (const f of changedFiles) {
          let d = normalizePath(path.dirname(f));
          while (d && d !== '.') {
            dirs.add(d);
            d = normalizePath(path.dirname(d));
          }
        }
        return dirs;
      })()
    : null;

  const insertContains = db.transaction(() => {
    // dir → file
    for (const relPath of fileSymbols.keys()) {
      const dir = normalizePath(path.dirname(relPath));
      if (!dir || dir === '.') continue;
      // On incremental, skip dirs whose contains edges are intact
      if (affectedDirs && !affectedDirs.has(dir)) continue;
      const dirRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
      const fileRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
      if (dirRow && fileRow) {
        insertEdge.run(dirRow.id, fileRow.id, 'contains', 1.0, 0);
      }
    }
    // dir → subdirectory
    for (const dir of allDirs) {
      const parent = normalizePath(path.dirname(dir));
      if (!parent || parent === '.' || parent === dir) continue;
      // On incremental, skip parent dirs whose contains edges are intact
      if (affectedDirs && !affectedDirs.has(parent)) continue;
      const parentRow = getNodeIdStmt.get(parent, 'directory', parent, 0);
      const childRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
      if (parentRow && childRow) {
        insertEdge.run(parentRow.id, childRow.id, 'contains', 1.0, 0);
      }
    }
  });
  insertContains();

  // Step 4: Compute per-file metrics
  // Pre-compute fan-in/fan-out per file from import edges
  const fanInMap = new Map();
  const fanOutMap = new Map();
  const importEdges = db
    .prepare(`
      SELECT n1.file AS source_file, n2.file AS target_file
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind IN ('imports', 'imports-type')
        AND n1.file != n2.file
    `)
    .all();

  for (const { source_file, target_file } of importEdges) {
    fanOutMap.set(source_file, (fanOutMap.get(source_file) || 0) + 1);
    fanInMap.set(target_file, (fanInMap.get(target_file) || 0) + 1);
  }

  const computeFileMetrics = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const fileRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
      if (!fileRow) continue;

      const lineCount = lineCountMap.get(relPath) || 0;
      // Deduplicate definitions by name+kind+line
      const seen = new Set();
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
  });
  computeFileMetrics();

  // Step 5: Compute per-directory metrics
  // Build a map of dir → descendant files
  const dirFiles = new Map();
  for (const dir of allDirs) {
    dirFiles.set(dir, []);
  }
  for (const relPath of fileSymbols.keys()) {
    let d = normalizePath(path.dirname(relPath));
    while (d && d !== '.') {
      if (dirFiles.has(d)) {
        dirFiles.get(d).push(relPath);
      }
      d = normalizePath(path.dirname(d));
    }
  }

  // Build reverse index: file → set of ancestor directories (O(files × depth))
  const fileToAncestorDirs = new Map();
  for (const [dir, files] of dirFiles) {
    for (const f of files) {
      if (!fileToAncestorDirs.has(f)) fileToAncestorDirs.set(f, new Set());
      fileToAncestorDirs.get(f).add(dir);
    }
  }

  // Single O(E) pass: pre-aggregate edge counts per directory
  const dirEdgeCounts = new Map();
  for (const dir of allDirs) {
    dirEdgeCounts.set(dir, { intra: 0, fanIn: 0, fanOut: 0 });
  }
  for (const { source_file, target_file } of importEdges) {
    const srcDirs = fileToAncestorDirs.get(source_file);
    const tgtDirs = fileToAncestorDirs.get(target_file);
    if (!srcDirs && !tgtDirs) continue;

    // For each directory that contains the source file
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
    // For each directory that contains the target but NOT the source
    if (tgtDirs) {
      for (const dir of tgtDirs) {
        if (srcDirs?.has(dir)) continue; // already counted as intra
        const counts = dirEdgeCounts.get(dir);
        if (!counts) continue;
        counts.fanIn++;
      }
    }
  }

  const computeDirMetrics = db.transaction(() => {
    for (const [dir, files] of dirFiles) {
      const dirRow = getNodeIdStmt.get(dir, 'directory', dir, 0);
      if (!dirRow) continue;

      const fileCount = files.length;
      let symbolCount = 0;

      for (const f of files) {
        const sym = fileSymbols.get(f);
        if (sym) {
          const seen = new Set();
          for (const d of sym.definitions) {
            const key = `${d.name}|${d.kind}|${d.line}`;
            if (!seen.has(key)) {
              seen.add(key);
              symbolCount++;
            }
          }
        }
      }

      // O(1) lookup from pre-aggregated edge counts
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
  });
  computeDirMetrics();

  const dirCount = allDirs.size;
  debug(`Structure: ${dirCount} directories, ${fileSymbols.size} files with metrics`);
}

// ─── Node role classification ─────────────────────────────────────────

// Re-export from classifier for backward compatibility
export { FRAMEWORK_ENTRY_PREFIXES } from './graph/classifiers/roles.js';

import { classifyRoles } from './graph/classifiers/roles.js';

export function classifyNodeRoles(db) {
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
    .all();

  if (rows.length === 0) {
    return { entry: 0, core: 0, utility: 0, adapter: 0, dead: 0, leaf: 0 };
  }

  const exportedIds = new Set(
    db
      .prepare(
        `SELECT DISTINCT e.target_id
        FROM edges e
        JOIN nodes caller ON e.source_id = caller.id
        JOIN nodes target ON e.target_id = target.id
        WHERE e.kind = 'calls' AND caller.file != target.file`,
      )
      .all()
      .map((r) => r.target_id),
  );

  // Delegate classification to the pure-logic classifier
  const classifierInput = rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
    isExported: exportedIds.has(r.id),
  }));

  const roleMap = classifyRoles(classifierInput);

  // Build summary and updates
  const summary = { entry: 0, core: 0, utility: 0, adapter: 0, dead: 0, leaf: 0 };
  const updates = [];
  for (const row of rows) {
    const role = roleMap.get(String(row.id)) || 'leaf';
    updates.push({ id: row.id, role });
    summary[role]++;
  }

  const clearRoles = db.prepare('UPDATE nodes SET role = NULL');
  const setRole = db.prepare('UPDATE nodes SET role = ? WHERE id = ?');

  db.transaction(() => {
    clearRoles.run();
    for (const u of updates) {
      setRole.run(u.role, u.id);
    }
  })();

  return summary;
}

// ─── Query functions (read-only) ──────────────────────────────────────

/**
 * Return hierarchical directory tree with metrics.
 */
export function structureData(customDbPath, opts = {}) {
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
      .all();

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
    const result = dirs.map((d) => {
      let files = db
        .prepare(`
          SELECT n.name, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count, nm.fan_in, nm.fan_out
          FROM edges e
          JOIN nodes n ON e.target_id = n.id
          LEFT JOIN node_metrics nm ON n.id = nm.node_id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
        .all(d.id);
      if (noTests) files = files.filter((f) => !isTestFile(f.name));

      const subdirs = db
        .prepare(`
          SELECT n.name
          FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'directory'
        `)
        .all(d.id);

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

/**
 * Return top N files or directories ranked by a chosen metric.
 */
export function hotspotsData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const metric = opts.metric || 'fan-in';
    const level = opts.level || 'file';
    const limit = opts.limit || 10;
    const noTests = opts.noTests || false;

    const kind = level === 'directory' ? 'directory' : 'file';

    const testFilter = testFilterSQL('n.name', noTests && kind === 'file');

    const HOTSPOT_QUERIES = {
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

    const stmt = HOTSPOT_QUERIES[metric] || HOTSPOT_QUERIES['fan-in'];
    const rows = stmt.all(kind, limit);

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
        r.file_count > 0
          ? (r.symbol_count || 0) / r.file_count
          : r.line_count > 0
            ? (r.symbol_count || 0) / r.line_count
            : 0,
      coupling: (r.fan_in || 0) + (r.fan_out || 0),
    }));

    const base = { metric, level, limit, hotspots };
    return paginateResult(base, 'hotspots', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

/**
 * Return directories with cohesion above threshold, with top exports/imports.
 */
export function moduleBoundariesData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const threshold = opts.threshold || 0.3;

    const dirs = db
      .prepare(`
        SELECT n.id, n.name, nm.symbol_count, nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n
        JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'directory' AND nm.cohesion IS NOT NULL AND nm.cohesion >= ?
        ORDER BY nm.cohesion DESC
      `)
      .all(threshold);

    const modules = dirs.map((d) => {
      // Get files inside this directory
      const files = db
        .prepare(`
          SELECT n.name FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
        .all(d.id)
        .map((f) => f.name);

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

function getSortFn(sortBy) {
  switch (sortBy) {
    case 'cohesion':
      return (a, b) => (b.cohesion ?? -1) - (a.cohesion ?? -1);
    case 'fan-in':
      return (a, b) => (b.fan_in || 0) - (a.fan_in || 0);
    case 'fan-out':
      return (a, b) => (b.fan_out || 0) - (a.fan_out || 0);
    case 'density':
      return (a, b) => {
        const da = a.file_count > 0 ? (a.symbol_count || 0) / a.file_count : 0;
        const db_ = b.file_count > 0 ? (b.symbol_count || 0) / b.file_count : 0;
        return db_ - da;
      };
    default:
      return (a, b) => a.name.localeCompare(b.name);
  }
}
