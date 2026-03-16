import path from 'node:path';
import { openReadonlyOrFail, testFilterSQL } from '../../db/index.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { findCycles } from '../graph/cycles.js';
import { LANGUAGE_REGISTRY } from '../parser.js';

export const FALSE_POSITIVE_NAMES = new Set([
  'run',
  'get',
  'set',
  'init',
  'start',
  'handle',
  'main',
  'new',
  'create',
  'update',
  'delete',
  'process',
  'execute',
  'call',
  'apply',
  'setup',
  'render',
  'build',
  'load',
  'save',
  'find',
  'make',
  'open',
  'close',
  'reset',
  'send',
  'read',
  'write',
]);
export const FALSE_POSITIVE_CALLER_THRESHOLD = 20;

export function moduleMapData(customDbPath, limit = 20, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    const testFilter = testFilterSQL('n.file', noTests);

    const nodes = db
      .prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM edges WHERE source_id = n.id AND kind NOT IN ('contains', 'parameter_of', 'receiver')) as out_edges,
        (SELECT COUNT(*) FROM edges WHERE target_id = n.id AND kind NOT IN ('contains', 'parameter_of', 'receiver')) as in_edges
      FROM nodes n
      WHERE n.kind = 'file'
        ${testFilter}
      ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id AND kind NOT IN ('contains', 'parameter_of', 'receiver')) DESC
      LIMIT ?
    `)
      .all(limit);

    const topNodes = nodes.map((n) => ({
      file: n.file,
      dir: path.dirname(n.file) || '.',
      inEdges: n.in_edges,
      outEdges: n.out_edges,
      coupling: n.in_edges + n.out_edges,
    }));

    const totalNodes = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    const totalEdges = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
    const totalFiles = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get().c;

    return { limit, topNodes, stats: { totalFiles, totalNodes, totalEdges } };
  } finally {
    db.close();
  }
}

export function statsData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    // Build set of test file IDs for filtering nodes and edges
    let testFileIds = null;
    if (noTests) {
      const allFileNodes = db.prepare("SELECT id, file FROM nodes WHERE kind = 'file'").all();
      testFileIds = new Set();
      const testFiles = new Set();
      for (const n of allFileNodes) {
        if (isTestFile(n.file)) {
          testFileIds.add(n.id);
          testFiles.add(n.file);
        }
      }

      // Also collect non-file node IDs that belong to test files
      const allNodes = db.prepare('SELECT id, file FROM nodes').all();
      for (const n of allNodes) {
        if (testFiles.has(n.file)) testFileIds.add(n.id);
      }
    }

    // Node breakdown by kind
    let nodeRows;
    if (noTests) {
      const allNodes = db.prepare('SELECT id, kind, file FROM nodes').all();
      const filtered = allNodes.filter((n) => !testFileIds.has(n.id));
      const counts = {};
      for (const n of filtered) counts[n.kind] = (counts[n.kind] || 0) + 1;
      nodeRows = Object.entries(counts).map(([kind, c]) => ({ kind, c }));
    } else {
      nodeRows = db.prepare('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind').all();
    }
    const nodesByKind = {};
    let totalNodes = 0;
    for (const r of nodeRows) {
      nodesByKind[r.kind] = r.c;
      totalNodes += r.c;
    }

    // Edge breakdown by kind
    let edgeRows;
    if (noTests) {
      const allEdges = db.prepare('SELECT source_id, target_id, kind FROM edges').all();
      const filtered = allEdges.filter(
        (e) => !testFileIds.has(e.source_id) && !testFileIds.has(e.target_id),
      );
      const counts = {};
      for (const e of filtered) counts[e.kind] = (counts[e.kind] || 0) + 1;
      edgeRows = Object.entries(counts).map(([kind, c]) => ({ kind, c }));
    } else {
      edgeRows = db.prepare('SELECT kind, COUNT(*) as c FROM edges GROUP BY kind').all();
    }
    const edgesByKind = {};
    let totalEdges = 0;
    for (const r of edgeRows) {
      edgesByKind[r.kind] = r.c;
      totalEdges += r.c;
    }

    // File/language distribution — map extensions via LANGUAGE_REGISTRY
    const extToLang = new Map();
    for (const entry of LANGUAGE_REGISTRY) {
      for (const ext of entry.extensions) {
        extToLang.set(ext, entry.id);
      }
    }
    let fileNodes = db.prepare("SELECT file FROM nodes WHERE kind = 'file'").all();
    if (noTests) fileNodes = fileNodes.filter((n) => !isTestFile(n.file));
    const byLanguage = {};
    for (const row of fileNodes) {
      const ext = path.extname(row.file).toLowerCase();
      const lang = extToLang.get(ext) || 'other';
      byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    }
    const langCount = Object.keys(byLanguage).length;

    // Cycles
    const fileCycles = findCycles(db, { fileLevel: true, noTests });
    const fnCycles = findCycles(db, { fileLevel: false, noTests });

    // Top 5 coupling hotspots (fan-in + fan-out, file nodes)
    const testFilter = testFilterSQL('n.file', noTests);
    const hotspotRows = db
      .prepare(`
      SELECT n.file,
        (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as fan_in,
        (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as fan_out
      FROM nodes n
      WHERE n.kind = 'file' ${testFilter}
      ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id)
             + (SELECT COUNT(*) FROM edges WHERE source_id = n.id) DESC
    `)
      .all();
    const filteredHotspots = noTests ? hotspotRows.filter((r) => !isTestFile(r.file)) : hotspotRows;
    const hotspots = filteredHotspots.slice(0, 5).map((r) => ({
      file: r.file,
      fanIn: r.fan_in,
      fanOut: r.fan_out,
    }));

    // Embeddings metadata
    let embeddings = null;
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get();
      if (count && count.c > 0) {
        const meta = {};
        const metaRows = db.prepare('SELECT key, value FROM embedding_meta').all();
        for (const r of metaRows) meta[r.key] = r.value;
        embeddings = {
          count: count.c,
          model: meta.model || null,
          dim: meta.dim ? parseInt(meta.dim, 10) : null,
          builtAt: meta.built_at || null,
        };
      }
    } catch {
      /* embeddings table may not exist */
    }

    // Graph quality metrics
    const qualityTestFilter = testFilter.replace(/n\.file/g, 'file');
    const totalCallable = db
      .prepare(
        `SELECT COUNT(*) as c FROM nodes WHERE kind IN ('function', 'method') ${qualityTestFilter}`,
      )
      .get().c;
    const callableWithCallers = db
      .prepare(`
        SELECT COUNT(DISTINCT e.target_id) as c FROM edges e
        JOIN nodes n ON e.target_id = n.id
        WHERE e.kind = 'calls' AND n.kind IN ('function', 'method') ${testFilter}
      `)
      .get().c;
    const callerCoverage = totalCallable > 0 ? callableWithCallers / totalCallable : 0;

    const totalCallEdges = db
      .prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls'")
      .get().c;
    const highConfCallEdges = db
      .prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls' AND confidence >= 0.7")
      .get().c;
    const callConfidence = totalCallEdges > 0 ? highConfCallEdges / totalCallEdges : 0;

    // False-positive warnings: generic names with > threshold callers
    const fpRows = db
      .prepare(`
        SELECT n.name, n.file, n.line, COUNT(e.source_id) as caller_count
        FROM nodes n
        LEFT JOIN edges e ON n.id = e.target_id AND e.kind = 'calls'
        WHERE n.kind IN ('function', 'method')
        GROUP BY n.id
        HAVING caller_count > ?
        ORDER BY caller_count DESC
      `)
      .all(FALSE_POSITIVE_CALLER_THRESHOLD);
    const falsePositiveWarnings = fpRows
      .filter((r) =>
        FALSE_POSITIVE_NAMES.has(r.name.includes('.') ? r.name.split('.').pop() : r.name),
      )
      .map((r) => ({ name: r.name, file: r.file, line: r.line, callerCount: r.caller_count }));

    // Edges from suspicious nodes
    let fpEdgeCount = 0;
    for (const fp of falsePositiveWarnings) fpEdgeCount += fp.callerCount;
    const falsePositiveRatio = totalCallEdges > 0 ? fpEdgeCount / totalCallEdges : 0;

    const score = Math.round(
      callerCoverage * 40 + callConfidence * 40 + (1 - falsePositiveRatio) * 20,
    );

    const quality = {
      score,
      callerCoverage: {
        ratio: callerCoverage,
        covered: callableWithCallers,
        total: totalCallable,
      },
      callConfidence: {
        ratio: callConfidence,
        highConf: highConfCallEdges,
        total: totalCallEdges,
      },
      falsePositiveWarnings,
    };

    // Role distribution
    let roleRows;
    if (noTests) {
      const allRoleNodes = db.prepare('SELECT role, file FROM nodes WHERE role IS NOT NULL').all();
      const filtered = allRoleNodes.filter((n) => !isTestFile(n.file));
      const counts = {};
      for (const n of filtered) counts[n.role] = (counts[n.role] || 0) + 1;
      roleRows = Object.entries(counts).map(([role, c]) => ({ role, c }));
    } else {
      roleRows = db
        .prepare('SELECT role, COUNT(*) as c FROM nodes WHERE role IS NOT NULL GROUP BY role')
        .all();
    }
    const roles = {};
    for (const r of roleRows) roles[r.role] = r.c;

    // Complexity summary
    let complexity = null;
    try {
      const cRows = db
        .prepare(
          `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index
         FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
         WHERE n.kind IN ('function','method') ${testFilter}`,
        )
        .all();
      if (cRows.length > 0) {
        const miValues = cRows.map((r) => r.maintainability_index || 0);
        complexity = {
          analyzed: cRows.length,
          avgCognitive: +(cRows.reduce((s, r) => s + r.cognitive, 0) / cRows.length).toFixed(1),
          avgCyclomatic: +(cRows.reduce((s, r) => s + r.cyclomatic, 0) / cRows.length).toFixed(1),
          maxCognitive: Math.max(...cRows.map((r) => r.cognitive)),
          maxCyclomatic: Math.max(...cRows.map((r) => r.cyclomatic)),
          avgMI: +(miValues.reduce((s, v) => s + v, 0) / miValues.length).toFixed(1),
          minMI: +Math.min(...miValues).toFixed(1),
        };
      }
    } catch {
      /* table may not exist in older DBs */
    }

    return {
      nodes: { total: totalNodes, byKind: nodesByKind },
      edges: { total: totalEdges, byKind: edgesByKind },
      files: { total: fileNodes.length, languages: langCount, byLanguage },
      cycles: { fileLevel: fileCycles.length, functionLevel: fnCycles.length },
      hotspots,
      embeddings,
      quality,
      roles,
      complexity,
    };
  } finally {
    db.close();
  }
}
