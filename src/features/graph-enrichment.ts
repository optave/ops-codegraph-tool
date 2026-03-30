import path from 'node:path';
import { louvainCommunities } from '../graph/algorithms/louvain.js';
import { CodeGraph } from '../graph/model.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import {
  COMMUNITY_COLORS,
  DEFAULT_NODE_COLORS,
  DEFAULT_ROLE_COLORS,
} from '../presentation/colors.js';
import { DEFAULT_CONFIG, type PlotConfig, renderPlotHTML } from '../presentation/viewer.js';
import type { BetterSqlite3Database } from '../types.js';

// Re-export presentation utilities for backward compatibility
export { loadPlotConfig } from '../presentation/viewer.js';

const DEFAULT_MIN_CONFIDENCE = 0.5;

// ─── Data Preparation ─────────────────────────────────────────────────

interface VisNode {
  id: number | string;
  label: string;
  title: string;
  color: string;
  kind: string;
  role: string;
  file: string;
  line: number;
  community: number | null;
  cognitive: number | null;
  cyclomatic: number | null;
  maintainabilityIndex: number | null;
  fanIn: number;
  fanOut: number;
  directory: string;
  risk: string[];
}

interface VisEdge {
  id: string;
  from: number | string;
  to: number | string;
}

interface GraphData {
  nodes: VisNode[];
  edges: VisEdge[];
  seedNodeIds: (number | string)[];
}

export function prepareGraphData(
  db: BetterSqlite3Database,
  opts: {
    fileLevel?: boolean;
    noTests?: boolean;
    minConfidence?: number;
    config?: PlotConfig;
  } = {},
): GraphData {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const cfg = opts.config || DEFAULT_CONFIG;

  return fileLevel
    ? prepareFileLevelData(db, noTests, minConf, cfg)
    : prepareFunctionLevelData(db, noTests, minConf, cfg);
}

interface FunctionEdgeRow {
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
}

type NodeInfo = {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  role: string | null;
};

/** Build node map from edge rows, collecting unique source/target nodes. */
function buildNodeMapFromEdges(edges: FunctionEdgeRow[]): Map<number, NodeInfo> {
  const nodeMap = new Map<number, NodeInfo>();
  for (const e of edges) {
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
  return nodeMap;
}

/** Load complexity data from function_complexity table. */
function loadComplexityMap(
  db: BetterSqlite3Database,
): Map<number, { cognitive: number; cyclomatic: number; maintainabilityIndex: number }> {
  const complexityMap = new Map<
    number,
    { cognitive: number; cyclomatic: number; maintainabilityIndex: number }
  >();
  try {
    const rows = db
      .prepare<{
        node_id: number;
        cognitive: number;
        cyclomatic: number;
        max_nesting: number;
        maintainability_index: number;
      }>(
        'SELECT node_id, cognitive, cyclomatic, max_nesting, maintainability_index FROM function_complexity',
      )
      .all();
    for (const r of rows) {
      complexityMap.set(r.node_id, {
        cognitive: r.cognitive,
        cyclomatic: r.cyclomatic,
        maintainabilityIndex: r.maintainability_index,
      });
    }
  } catch {
    // table may not exist in old DBs
  }
  return complexityMap;
}

/** Load fan-in and fan-out maps from edges table. */
function loadFanMaps(db: BetterSqlite3Database): {
  fanInMap: Map<number, number>;
  fanOutMap: Map<number, number>;
} {
  const fanInMap = new Map<number, number>();
  const fanOutMap = new Map<number, number>();

  const fanInRows = db
    .prepare<{ node_id: number; fan_in: number }>(
      "SELECT target_id AS node_id, COUNT(*) AS fan_in FROM edges WHERE kind = 'calls' GROUP BY target_id",
    )
    .all();
  for (const r of fanInRows) fanInMap.set(r.node_id, r.fan_in);

  const fanOutRows = db
    .prepare<{ node_id: number; fan_out: number }>(
      "SELECT source_id AS node_id, COUNT(*) AS fan_out FROM edges WHERE kind = 'calls' GROUP BY source_id",
    )
    .all();
  for (const r of fanOutRows) fanOutMap.set(r.node_id, r.fan_out);

  return { fanInMap, fanOutMap };
}

/** Build an enriched VisNode from raw node info and computed maps. */
function buildEnrichedVisNode(
  n: NodeInfo,
  complexityMap: Map<
    number,
    { cognitive: number; cyclomatic: number; maintainabilityIndex: number }
  >,
  fanInMap: Map<number, number>,
  fanOutMap: Map<number, number>,
  communityMap: Map<number, number>,
  cfg: PlotConfig,
): VisNode {
  const cx = complexityMap.get(n.id) || null;
  const fanIn = fanInMap.get(n.id) || 0;
  const fanOut = fanOutMap.get(n.id) || 0;
  const community = communityMap.get(n.id) ?? null;
  const directory = path.dirname(n.file);
  const risk: string[] = [];
  if (n.role?.startsWith('dead')) risk.push('dead-code');
  if (fanIn >= (cfg.riskThresholds?.highBlastRadius ?? 10)) risk.push('high-blast-radius');
  if (cx && cx.maintainabilityIndex < (cfg.riskThresholds?.lowMI ?? 40)) risk.push('low-mi');

  const color: string =
    cfg.colorBy === 'role' && n.role
      ? cfg.roleColors?.[n.role] ||
        (DEFAULT_ROLE_COLORS as Record<string, string>)[n.role] ||
        '#ccc'
      : cfg.colorBy === 'community' && community !== null
        ? COMMUNITY_COLORS[community % COMMUNITY_COLORS.length] || '#ccc'
        : cfg.nodeColors?.[n.kind] ||
          (DEFAULT_NODE_COLORS as Record<string, string>)[n.kind] ||
          '#ccc';

  return {
    id: n.id,
    label: n.name,
    title: `${n.file}:${n.line} (${n.kind}${n.role ? `, ${n.role}` : ''})`,
    color,
    kind: n.kind,
    role: n.role || '',
    file: n.file,
    line: n.line,
    community,
    cognitive: cx?.cognitive ?? null,
    cyclomatic: cx?.cyclomatic ?? null,
    maintainabilityIndex: cx?.maintainabilityIndex ?? null,
    fanIn,
    fanOut,
    directory,
    risk,
  };
}

/** Select seed node IDs based on configured strategy. */
function selectSeedNodes(visNodes: VisNode[], cfg: PlotConfig): (number | string)[] {
  if (cfg.seedStrategy === 'top-fanin') {
    const sorted = [...visNodes].sort((a, b) => b.fanIn - a.fanIn);
    return sorted.slice(0, cfg.seedCount || 30).map((n) => n.id);
  }
  if (cfg.seedStrategy === 'entry') {
    return visNodes.filter((n) => n.role === 'entry').map((n) => n.id);
  }
  return visNodes.map((n) => n.id);
}

function prepareFunctionLevelData(
  db: BetterSqlite3Database,
  noTests: boolean,
  minConf: number,
  cfg: PlotConfig,
): GraphData {
  let edges = db
    .prepare<FunctionEdgeRow>(
      `
      SELECT n1.id AS source_id, n1.name AS source_name, n1.kind AS source_kind,
             n1.file AS source_file, n1.line AS source_line, n1.role AS source_role,
             n2.id AS target_id, n2.name AS target_name, n2.kind AS target_kind,
             n2.file AS target_file, n2.line AS target_line, n2.role AS target_role,
             e.kind AS edge_kind
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

  if (cfg.filter?.kinds) {
    const kinds = new Set(cfg.filter.kinds);
    edges = edges.filter((e) => kinds.has(e.source_kind) && kinds.has(e.target_kind));
  }
  if (cfg.filter?.files) {
    const patterns = cfg.filter.files;
    edges = edges.filter(
      (e) =>
        patterns.some((p) => e.source_file.includes(p)) &&
        patterns.some((p) => e.target_file.includes(p)),
    );
  }

  const nodeMap = buildNodeMapFromEdges(edges);

  if (cfg.filter?.roles) {
    const roles = new Set(cfg.filter.roles);
    for (const [id, n] of nodeMap) {
      if (n.role === null || !roles.has(n.role)) nodeMap.delete(id);
    }
    const nodeIds = new Set(nodeMap.keys());
    edges = edges.filter((e) => nodeIds.has(e.source_id) && nodeIds.has(e.target_id));
  }

  const complexityMap = loadComplexityMap(db);

  // Build CodeGraph for Louvain community detection
  const fnGraph = new CodeGraph();
  for (const [id] of nodeMap) fnGraph.addNode(String(id));
  for (const e of edges) {
    const src = String(e.source_id);
    const tgt = String(e.target_id);
    if (src !== tgt && !fnGraph.hasEdge(src, tgt)) fnGraph.addEdge(src, tgt);
  }

  const { fanInMap, fanOutMap } = loadFanMaps(db);

  // Communities (Louvain) via graph subsystem
  const communityMap = new Map<number, number>();
  if (nodeMap.size > 0) {
    try {
      const { assignments } = louvainCommunities(fnGraph);
      for (const [nid, cid] of assignments) communityMap.set(Number(nid), cid);
    } catch {
      // louvain can fail on disconnected graphs
    }
  }

  const visNodes: VisNode[] = [...nodeMap.values()].map((n) =>
    buildEnrichedVisNode(n, complexityMap, fanInMap, fanOutMap, communityMap, cfg),
  );

  const visEdges: VisEdge[] = edges.map((e, i) => ({
    id: `e${i}`,
    from: e.source_id,
    to: e.target_id,
  }));

  return { nodes: visNodes, edges: visEdges, seedNodeIds: selectSeedNodes(visNodes, cfg) };
}

interface FileLevelEdge {
  source: string;
  target: string;
}

function prepareFileLevelData(
  db: BetterSqlite3Database,
  noTests: boolean,
  minConf: number,
  cfg: PlotConfig,
): GraphData {
  let edges = db
    .prepare<FileLevelEdge>(
      `
      SELECT DISTINCT n1.file AS source, n2.file AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
        AND e.confidence >= ?
    `,
    )
    .all(minConf);
  if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));

  const files = new Set<string>();
  for (const { source, target } of edges) {
    files.add(source);
    files.add(target);
  }

  const fileIds = new Map<string, number>();
  let idx = 0;
  for (const f of files) fileIds.set(f, idx++);

  // Fan-in/fan-out
  const fanInCount = new Map<string, number>();
  const fanOutCount = new Map<string, number>();
  for (const { source, target } of edges) {
    fanOutCount.set(source, (fanOutCount.get(source) || 0) + 1);
    fanInCount.set(target, (fanInCount.get(target) || 0) + 1);
  }

  // Communities via graph subsystem
  const communityMap = new Map<string, number>();
  if (files.size > 0) {
    try {
      const fileGraph = new CodeGraph();
      for (const f of files) fileGraph.addNode(f);
      for (const { source, target } of edges) {
        if (source !== target && !fileGraph.hasEdge(source, target))
          fileGraph.addEdge(source, target);
      }
      const { assignments } = louvainCommunities(fileGraph);
      for (const [file, cid] of assignments) communityMap.set(file, cid);
    } catch {
      // ignore
    }
  }

  const visNodes: VisNode[] = [...files].map((f) => {
    const id = fileIds.get(f)!;
    const community = communityMap.get(f) ?? null;
    const fanIn = fanInCount.get(f) || 0;
    const fanOut = fanOutCount.get(f) || 0;
    const directory = path.dirname(f);
    const color: string =
      cfg.colorBy === 'community' && community !== null
        ? COMMUNITY_COLORS[community % COMMUNITY_COLORS.length] || '#ccc'
        : cfg.nodeColors?.file || (DEFAULT_NODE_COLORS as Record<string, string>).file || '#ccc';

    return {
      id,
      label: path.basename(f),
      title: f,
      color,
      kind: 'file',
      role: '',
      file: f,
      line: 0,
      community,
      cognitive: null,
      cyclomatic: null,
      maintainabilityIndex: null,
      fanIn,
      fanOut,
      directory,
      risk: [],
    };
  });

  const visEdges: VisEdge[] = edges.map(({ source, target }, i) => ({
    id: `e${i}`,
    from: fileIds.get(source)!,
    to: fileIds.get(target)!,
  }));

  let seedNodeIds: (number | string)[];
  if (cfg.seedStrategy === 'top-fanin') {
    const sorted = [...visNodes].sort((a, b) => b.fanIn - a.fanIn);
    seedNodeIds = sorted.slice(0, cfg.seedCount || 30).map((n) => n.id);
  } else if (cfg.seedStrategy === 'entry') {
    seedNodeIds = visNodes.map((n) => n.id);
  } else {
    seedNodeIds = visNodes.map((n) => n.id);
  }

  return { nodes: visNodes, edges: visEdges, seedNodeIds };
}

// ─── HTML Generation (thin wrapper) ──────────────────────────────────

export function generatePlotHTML(
  db: BetterSqlite3Database,
  opts: {
    fileLevel?: boolean;
    noTests?: boolean;
    minConfidence?: number;
    config?: PlotConfig;
  } = {},
): string {
  const cfg = opts.config || DEFAULT_CONFIG;
  const data = prepareGraphData(db, opts);
  return renderPlotHTML(data, cfg);
}
