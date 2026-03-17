import path from 'node:path';
import { isTestFile } from '../infrastructure/test-filter.js';
import {
  renderFileLevelDOT,
  renderFileLevelGraphML,
  renderFileLevelMermaid,
  renderFileLevelNeo4jCSV,
  renderFunctionLevelDOT,
  renderFunctionLevelGraphML,
  renderFunctionLevelMermaid,
  renderFunctionLevelNeo4jCSV,
} from '../presentation/export.js';
import { paginateResult } from '../shared/paginate.js';

const DEFAULT_MIN_CONFIDENCE = 0.5;

// ─── Shared data loaders ─────────────────────────────────────────────

/**
 * Load file-level edges from DB with filtering.
 * @param {object} db
 * @param {object} opts
 * @param {boolean} [opts.includeKind] - Include edge_kind in SELECT DISTINCT
 * @param {boolean} [opts.includeConfidence] - Include confidence (adds a column to DISTINCT — use only when needed)
 * @returns {{ edges: Array, totalEdges: number }}
 */
function loadFileLevelEdges(
  db,
  { noTests, minConfidence, limit, includeKind = false, includeConfidence = false },
) {
  const minConf = minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const kindClause = includeKind ? ', e.kind AS edge_kind' : '';
  const confidenceClause = includeConfidence ? ', e.confidence' : '';
  let edges = db
    .prepare(
      `
      SELECT DISTINCT n1.file AS source, n2.file AS target${kindClause}${confidenceClause}
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
        AND e.confidence >= ?
    `,
    )
    .all(minConf);
  if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));
  const totalEdges = edges.length;
  if (limit && edges.length > limit) edges = edges.slice(0, limit);
  return { edges, totalEdges };
}

/**
 * Load function-level edges from DB with filtering.
 * Returns the maximal field set needed by any serializer.
 * @returns {{ edges: Array, totalEdges: number }}
 */
function loadFunctionLevelEdges(db, { noTests, minConfidence, limit }) {
  const minConf = minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  let edges = db
    .prepare(
      `
      SELECT n1.id AS source_id, n1.name AS source_name, n1.kind AS source_kind,
             n1.file AS source_file, n1.line AS source_line, n1.role AS source_role,
             n2.id AS target_id, n2.name AS target_name, n2.kind AS target_kind,
             n2.file AS target_file, n2.line AS target_line, n2.role AS target_role,
             e.kind AS edge_kind, e.confidence
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')
        AND n2.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')
        AND e.kind = 'calls'
        AND e.confidence >= ?
    `,
    )
    .all(minConf);
  if (noTests)
    edges = edges.filter((e) => !isTestFile(e.source_file) && !isTestFile(e.target_file));
  const totalEdges = edges.length;
  if (limit && edges.length > limit) edges = edges.slice(0, limit);
  return { edges, totalEdges };
}

/**
 * Load directory groupings for file-level graphs.
 * Uses DB directory nodes if available, falls back to path.dirname().
 * @returns {Array<{ name: string, files: Array<{ path: string, basename: string }>, cohesion: number|null }>}
 */
function loadDirectoryGroups(db, allFiles) {
  const hasDirectoryNodes =
    db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get().c > 0;

  const dirs = new Map();

  if (hasDirectoryNodes) {
    const dbDirs = db
      .prepare(`
        SELECT n.id, n.name, nm.cohesion
        FROM nodes n
        LEFT JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'directory'
      `)
      .all();

    for (const d of dbDirs) {
      const containedFiles = db
        .prepare(`
          SELECT n.name FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
        .all(d.id)
        .map((r) => r.name)
        .filter((f) => allFiles.has(f));

      if (containedFiles.length > 0) {
        dirs.set(d.name, { files: containedFiles, cohesion: d.cohesion ?? null });
      }
    }
  } else {
    for (const file of allFiles) {
      const dir = path.dirname(file) || '.';
      if (!dirs.has(dir)) dirs.set(dir, { files: [], cohesion: null });
      dirs.get(dir).files.push(file);
    }
  }

  return [...dirs]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, info]) => ({
      name,
      files: info.files.map((f) => ({ path: f, basename: path.basename(f) })),
      cohesion: info.cohesion,
    }));
}

/**
 * Load directory groupings for Mermaid file-level graphs (simplified — no cohesion, string arrays).
 */
function loadMermaidDirectoryGroups(db, allFiles) {
  const hasDirectoryNodes =
    db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get().c > 0;

  const dirs = new Map();

  if (hasDirectoryNodes) {
    const dbDirs = db.prepare("SELECT id, name FROM nodes WHERE kind = 'directory'").all();
    for (const d of dbDirs) {
      const containedFiles = db
        .prepare(`
          SELECT n.name FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
        .all(d.id)
        .map((r) => r.name)
        .filter((f) => allFiles.has(f));
      if (containedFiles.length > 0) dirs.set(d.name, containedFiles);
    }
  } else {
    for (const file of allFiles) {
      const dir = path.dirname(file) || '.';
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(file);
    }
  }

  return [...dirs]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, files]) => ({ name, files }));
}

/**
 * Load node roles for Mermaid function-level styling.
 * @returns {Map<string, string>} "file::name" → role
 */
function loadNodeRoles(db, edges) {
  const roles = new Map();
  const seen = new Set();
  for (const e of edges) {
    for (const [file, name] of [
      [e.source_file, e.source_name],
      [e.target_file, e.target_name],
    ]) {
      const key = `${file}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = db
        .prepare('SELECT role FROM nodes WHERE file = ? AND name = ? AND role IS NOT NULL LIMIT 1')
        .get(file, name);
      if (row?.role) roles.set(key, row.role);
    }
  }
  return roles;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Export the dependency graph in DOT (Graphviz) format.
 */
export function exportDOT(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConfidence = opts.minConfidence;
  const limit = opts.limit;

  if (fileLevel) {
    const { edges, totalEdges } = loadFileLevelEdges(db, { noTests, minConfidence, limit });
    const allFiles = new Set();
    for (const { source, target } of edges) {
      allFiles.add(source);
      allFiles.add(target);
    }
    const dirs = loadDirectoryGroups(db, allFiles);
    return renderFileLevelDOT({ dirs, edges, totalEdges, limit });
  }

  const { edges, totalEdges } = loadFunctionLevelEdges(db, { noTests, minConfidence, limit });
  return renderFunctionLevelDOT({ edges, totalEdges, limit });
}

/**
 * Export the dependency graph in Mermaid format.
 */
export function exportMermaid(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConfidence = opts.minConfidence;
  const direction = opts.direction || 'LR';
  const limit = opts.limit;

  if (fileLevel) {
    const { edges, totalEdges } = loadFileLevelEdges(db, {
      noTests,
      minConfidence,
      limit,
      includeKind: true,
    });
    const allFiles = new Set();
    for (const { source, target } of edges) {
      allFiles.add(source);
      allFiles.add(target);
    }
    const dirs = loadMermaidDirectoryGroups(db, allFiles);
    return renderFileLevelMermaid({ direction, dirs, edges, totalEdges, limit });
  }

  const { edges, totalEdges } = loadFunctionLevelEdges(db, { noTests, minConfidence, limit });
  const roles = loadNodeRoles(db, edges);
  return renderFunctionLevelMermaid({ direction, edges, roles, totalEdges, limit });
}

/**
 * Export as JSON adjacency list.
 */
export function exportJSON(db, opts = {}) {
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  let nodes = db
    .prepare(`
    SELECT id, name, kind, file, line FROM nodes WHERE kind = 'file'
  `)
    .all();
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  let edges = db
    .prepare(`
    SELECT DISTINCT n1.file AS source, n2.file AS target, e.kind, e.confidence
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE n1.file != n2.file AND e.confidence >= ?
  `)
    .all(minConf);
  if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));

  const base = { nodes, edges };
  return paginateResult(base, 'edges', { limit: opts.limit, offset: opts.offset });
}

/**
 * Export the dependency graph in GraphML (XML) format.
 */
export function exportGraphML(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConfidence = opts.minConfidence;
  const limit = opts.limit;

  if (fileLevel) {
    const { edges } = loadFileLevelEdges(db, { noTests, minConfidence, limit });
    return renderFileLevelGraphML({ edges });
  }

  const { edges } = loadFunctionLevelEdges(db, { noTests, minConfidence, limit });
  return renderFunctionLevelGraphML({ edges });
}

/**
 * Export the dependency graph in TinkerPop GraphSON v3 format.
 */
export function exportGraphSON(db, opts = {}) {
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  let nodes = db
    .prepare(`
    SELECT id, name, kind, file, line, role FROM nodes
    WHERE kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant', 'file')
  `)
    .all();
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  let edges = db
    .prepare(`
    SELECT e.rowid AS id, n1.id AS outV, n2.id AS inV, e.kind, e.confidence
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE e.confidence >= ?
  `)
    .all(minConf);
  if (noTests) {
    const nodeIds = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => nodeIds.has(e.outV) && nodeIds.has(e.inV));
  }

  const vertices = nodes.map((n) => ({
    id: n.id,
    label: n.kind,
    properties: {
      name: [{ id: 0, value: n.name }],
      file: [{ id: 0, value: n.file }],
      ...(n.line != null ? { line: [{ id: 0, value: n.line }] } : {}),
      ...(n.role ? { role: [{ id: 0, value: n.role }] } : {}),
    },
  }));

  const gEdges = edges.map((e) => ({
    id: e.id,
    label: e.kind,
    inV: e.inV,
    outV: e.outV,
    properties: {
      confidence: e.confidence,
    },
  }));

  const base = { vertices, edges: gEdges };
  return paginateResult(base, 'edges', { limit: opts.limit, offset: opts.offset });
}

/**
 * Export the dependency graph as Neo4j bulk-import CSV files.
 * Returns { nodes: string, relationships: string }.
 */
export function exportNeo4jCSV(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConfidence = opts.minConfidence;
  const limit = opts.limit;

  if (fileLevel) {
    const { edges } = loadFileLevelEdges(db, {
      noTests,
      minConfidence,
      limit,
      includeKind: true,
      includeConfidence: true,
    });
    return renderFileLevelNeo4jCSV({ edges });
  }

  const { edges } = loadFunctionLevelEdges(db, { noTests, minConfidence, limit });
  return renderFunctionLevelNeo4jCSV({ edges });
}
