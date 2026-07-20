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
import type { BetterSqlite3Database, ExportNeo4jCSVResult, ExportOpts } from '../types.js';

const DEFAULT_MIN_CONFIDENCE = 0.5;

// ─── Internal interfaces ────────────────────────────────────────────

interface FileLevelEdge {
  source: string;
  target: string;
  edge_kind?: string;
  confidence?: number;
}

interface FunctionLevelEdge {
  source_id: number;
  source_name: string;
  source_kind: string;
  source_file: string;
  source_line: number;
  source_role: string | null;
  target_id: number;
  target_name: string;
  target_kind: string;
  target_file: string;
  target_line: number;
  target_role: string | null;
  edge_kind: string;
  confidence: number;
}

interface DirectoryGroup {
  name: string;
  files: Array<{ path: string; basename: string }>;
  cohesion: number | null;
}

interface MermaidDirectoryGroup {
  name: string;
  files: string[];
}

interface FileLevelLoadOpts {
  noTests: boolean;
  minConfidence?: number;
  limit?: number;
  includeKind?: boolean;
  includeConfidence?: boolean;
}

interface FunctionLevelLoadOpts {
  noTests: boolean;
  minConfidence?: number;
  limit?: number;
}

// ─── Shared data loaders ─────────────────────────────────────────────

/**
 * Load file-level edges from DB with filtering.
 */
function loadFileLevelEdges(
  db: BetterSqlite3Database,
  {
    noTests,
    minConfidence,
    limit,
    includeKind = false,
    includeConfidence = false,
  }: FileLevelLoadOpts,
): { edges: FileLevelEdge[]; totalEdges: number } {
  const minConf = minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const kindClause = includeKind ? ', e.kind AS edge_kind' : '';
  const confidenceClause = includeConfidence ? ', e.confidence' : '';
  let edges: FileLevelEdge[] = db
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
    .all(minConf) as FileLevelEdge[];
  if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));
  const totalEdges = edges.length;
  if (limit && edges.length > limit) edges = edges.slice(0, limit);
  return { edges, totalEdges };
}

/**
 * Load function-level edges from DB with filtering.
 * Returns the maximal field set needed by any serializer.
 */
function loadFunctionLevelEdges(
  db: BetterSqlite3Database,
  { noTests, minConfidence, limit }: FunctionLevelLoadOpts,
): { edges: FunctionLevelEdge[]; totalEdges: number } {
  const minConf = minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  let edges: FunctionLevelEdge[] = db
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
    .all(minConf) as FunctionLevelEdge[];
  if (noTests)
    edges = edges.filter((e) => !isTestFile(e.source_file) && !isTestFile(e.target_file));
  const totalEdges = edges.length;
  if (limit && edges.length > limit) edges = edges.slice(0, limit);
  return { edges, totalEdges };
}

/**
 * Load directory groupings for file-level graphs.
 * Uses DB directory nodes if available, falls back to path.dirname().
 */
function loadDirectoryGroups(db: BetterSqlite3Database, allFiles: Set<string>): DirectoryGroup[] {
  const hasDirectoryNodes =
    (db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get() as { c: number })
      .c > 0;

  const dirs = new Map<string, { files: string[]; cohesion: number | null }>();

  if (hasDirectoryNodes) {
    const dbDirs = db
      .prepare(`
        SELECT n.id, n.name, nm.cohesion
        FROM nodes n
        LEFT JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'directory'
      `)
      .all() as Array<{ id: number; name: string; cohesion: number | null }>;

    for (const d of dbDirs) {
      const containedFiles = (
        db
          .prepare(`
          SELECT n.name FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
          .all(d.id) as Array<{ name: string }>
      )
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
      dirs.get(dir)?.files.push(file);
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
function loadMermaidDirectoryGroups(
  db: BetterSqlite3Database,
  allFiles: Set<string>,
): MermaidDirectoryGroup[] {
  const hasDirectoryNodes =
    (db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get() as { c: number })
      .c > 0;

  const dirs = new Map<string, string[]>();

  if (hasDirectoryNodes) {
    const dbDirs = db
      .prepare("SELECT id, name FROM nodes WHERE kind = 'directory'")
      .all() as Array<{ id: number; name: string }>;
    for (const d of dbDirs) {
      const containedFiles = (
        db
          .prepare(`
          SELECT n.name FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
          .all(d.id) as Array<{ name: string }>
      )
        .map((r) => r.name)
        .filter((f) => allFiles.has(f));
      if (containedFiles.length > 0) dirs.set(d.name, containedFiles);
    }
  } else {
    for (const file of allFiles) {
      const dir = path.dirname(file) || '.';
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)?.push(file);
    }
  }

  return [...dirs]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, files]) => ({ name, files }));
}

/**
 * Load node roles for Mermaid function-level styling.
 */
function loadNodeRoles(db: BetterSqlite3Database, edges: FunctionLevelEdge[]): Map<string, string> {
  const roles = new Map<string, string>();
  const seen = new Set<string>();
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
        .get(file, name) as { role: string } | undefined;
      if (row?.role) roles.set(key, row.role);
    }
  }
  return roles;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Export the dependency graph in DOT (Graphviz) format.
 */
export function exportDOT(db: BetterSqlite3Database, opts: ExportOpts = {}): string {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConfidence = opts.minConfidence;
  const limit = opts.limit;

  if (fileLevel) {
    const { edges, totalEdges } = loadFileLevelEdges(db, { noTests, minConfidence, limit });
    const allFiles = new Set<string>();
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
export function exportMermaid(
  db: BetterSqlite3Database,
  opts: ExportOpts & { direction?: string } = {},
): string {
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
    const allFiles = new Set<string>();
    for (const { source, target } of edges) {
      allFiles.add(source);
      allFiles.add(target);
    }
    const dirs = loadMermaidDirectoryGroups(db, allFiles);
    return renderFileLevelMermaid({
      direction,
      dirs,
      edges: edges as Array<{ source: string; target: string; edge_kind: string }>,
      totalEdges,
      limit,
    });
  }

  const { edges, totalEdges } = loadFunctionLevelEdges(db, { noTests, minConfidence, limit });
  const roles = loadNodeRoles(db, edges);
  return renderFunctionLevelMermaid({ direction, edges, roles, totalEdges, limit });
}

/**
 * Export as JSON adjacency list.
 */
export function exportJSON(
  db: BetterSqlite3Database,
  opts: ExportOpts = {},
): { nodes: unknown[]; edges: unknown[] } {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  if (fileLevel) {
    let nodes = db
      .prepare(`
      SELECT id, name, kind, file, line FROM nodes WHERE kind = 'file'
    `)
      .all() as Array<{ id: number; name: string; kind: string; file: string; line: number }>;
    if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

    let edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target, e.kind, e.confidence
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.confidence >= ?
    `)
      .all(minConf) as Array<{ source: string; target: string; kind: string; confidence: number }>;
    if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));

    const base = { nodes, edges };
    return paginateResult(base, 'edges', { limit: opts.limit, offset: opts.offset }) as {
      nodes: unknown[];
      edges: unknown[];
    };
  }

  const { edges: fnEdges } = loadFunctionLevelEdges(db, {
    noTests,
    minConfidence: opts.minConfidence,
  });
  const nodeMap = new Map<
    number,
    { id: number; name: string; kind: string; file: string; line: number; role: string | null }
  >();
  for (const e of fnEdges) {
    if (!nodeMap.has(e.source_id)) {
      nodeMap.set(e.source_id, {
        id: e.source_id,
        name: e.source_name,
        kind: e.source_kind,
        file: e.source_file,
        line: e.source_line,
        role: e.source_role,
      });
    }
    if (!nodeMap.has(e.target_id)) {
      nodeMap.set(e.target_id, {
        id: e.target_id,
        name: e.target_name,
        kind: e.target_kind,
        file: e.target_file,
        line: e.target_line,
        role: e.target_role,
      });
    }
  }
  const nodes = [...nodeMap.values()];
  const edges = fnEdges.map((e) => ({
    source: e.source_id,
    target: e.target_id,
    kind: e.edge_kind,
    confidence: e.confidence,
  }));

  const base = { nodes, edges };
  return paginateResult(base, 'edges', { limit: opts.limit, offset: opts.offset }) as {
    nodes: unknown[];
    edges: unknown[];
  };
}

/**
 * Export the dependency graph in GraphML (XML) format.
 */
export function exportGraphML(db: BetterSqlite3Database, opts: ExportOpts = {}): string {
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
export function exportGraphSON(
  db: BetterSqlite3Database,
  opts: ExportOpts = {},
): { vertices: unknown[]; edges: unknown[] } {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;

  let vertices: Array<{ id: unknown; label: string; properties: Record<string, unknown> }>;
  let gEdges: Array<{
    id: unknown;
    label: string;
    inV: unknown;
    outV: unknown;
    properties: Record<string, unknown>;
  }>;

  if (fileLevel) {
    const { edges: fileEdges } = loadFileLevelEdges(db, {
      noTests,
      minConfidence: opts.minConfidence,
      includeKind: true,
      includeConfidence: true,
    });
    const filesInvolved = new Set<string>();
    for (const e of fileEdges) {
      filesInvolved.add(e.source);
      filesInvolved.add(e.target);
    }
    const fileNodes = db
      .prepare(`SELECT id, name, file, line FROM nodes WHERE kind = 'file'`)
      .all() as Array<{ id: number; name: string; file: string; line: number | null }>;
    const idByFile = new Map(
      fileNodes.filter((n) => filesInvolved.has(n.file)).map((n) => [n.file, n]),
    );

    vertices = [...idByFile.values()].map((n) => ({
      id: n.id,
      label: 'file',
      properties: {
        name: [{ id: 0, value: n.name }],
        file: [{ id: 0, value: n.file }],
        ...(n.line != null ? { line: [{ id: 0, value: n.line }] } : {}),
      },
    }));

    gEdges = fileEdges
      .filter((e) => idByFile.has(e.source) && idByFile.has(e.target))
      .map((e, i) => ({
        id: i,
        label: e.edge_kind ?? 'edge',
        inV: idByFile.get(e.target)?.id,
        outV: idByFile.get(e.source)?.id,
        properties: { confidence: e.confidence },
      }));
  } else {
    const { edges: fnEdges } = loadFunctionLevelEdges(db, {
      noTests,
      minConfidence: opts.minConfidence,
    });

    const nodeMap = new Map<
      number,
      { id: number; name: string; kind: string; file: string; line: number; role: string | null }
    >();
    for (const e of fnEdges) {
      if (!nodeMap.has(e.source_id)) {
        nodeMap.set(e.source_id, {
          id: e.source_id,
          name: e.source_name,
          kind: e.source_kind,
          file: e.source_file,
          line: e.source_line,
          role: e.source_role,
        });
      }
      if (!nodeMap.has(e.target_id)) {
        nodeMap.set(e.target_id, {
          id: e.target_id,
          name: e.target_name,
          kind: e.target_kind,
          file: e.target_file,
          line: e.target_line,
          role: e.target_role,
        });
      }
    }

    vertices = [...nodeMap.values()].map((n) => ({
      id: n.id,
      label: n.kind,
      properties: {
        name: [{ id: 0, value: n.name }],
        file: [{ id: 0, value: n.file }],
        ...(n.line != null ? { line: [{ id: 0, value: n.line }] } : {}),
        ...(n.role ? { role: [{ id: 0, value: n.role }] } : {}),
      },
    }));

    gEdges = fnEdges.map((e, i) => ({
      id: i,
      label: e.edge_kind,
      inV: e.target_id,
      outV: e.source_id,
      properties: {
        confidence: e.confidence,
      },
    }));
  }

  const base = { vertices, edges: gEdges };
  return paginateResult(base, 'edges', { limit: opts.limit, offset: opts.offset }) as {
    vertices: unknown[];
    edges: unknown[];
  };
}

/**
 * Export the dependency graph as Neo4j bulk-import CSV files.
 * Returns { nodes: string, relationships: string }.
 */
export function exportNeo4jCSV(
  db: BetterSqlite3Database,
  opts: ExportOpts = {},
): ExportNeo4jCSVResult {
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
    return renderFileLevelNeo4jCSV({
      edges: edges as Array<{
        source: string;
        target: string;
        edge_kind: string;
        confidence: number;
      }>,
    });
  }

  const { edges } = loadFunctionLevelEdges(db, { noTests, minConfidence, limit });
  return renderFunctionLevelNeo4jCSV({ edges });
}
