import path from 'node:path';
import { louvainCommunities } from './graph/algorithms/louvain.js';
import { CodeGraph } from './graph/model.js';
import { isTestFile } from './infrastructure/test-filter.js';
import {
  COMMUNITY_COLORS,
  DEFAULT_NODE_COLORS,
  DEFAULT_ROLE_COLORS,
} from './presentation/colors.js';
import { DEFAULT_CONFIG, renderPlotHTML } from './presentation/viewer.js';

// Re-export presentation utilities for backward compatibility
export { loadPlotConfig } from './presentation/viewer.js';

const DEFAULT_MIN_CONFIDENCE = 0.5;

// ─── Data Preparation ─────────────────────────────────────────────────

/**
 * Prepare enriched graph data for the HTML viewer.
 */
export function prepareGraphData(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const cfg = opts.config || DEFAULT_CONFIG;

  return fileLevel
    ? prepareFileLevelData(db, noTests, minConf, cfg)
    : prepareFunctionLevelData(db, noTests, minConf, cfg);
}

function prepareFunctionLevelData(db, noTests, minConf, cfg) {
  let edges = db
    .prepare(
      `
      SELECT n1.id AS source_id, n1.name AS source_name, n1.kind AS source_kind,
             n1.file AS source_file, n1.line AS source_line, n1.role AS source_role,
             n2.id AS target_id, n2.name AS target_name, n2.kind AS target_kind,
             n2.file AS target_file, n2.line AS target_line, n2.role AS target_role,
             e.kind AS edge_kind
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')
        AND n2.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')
        AND e.kind = 'calls'
        AND e.confidence >= ?
    `,
    )
    .all(minConf);
  if (noTests)
    edges = edges.filter((e) => !isTestFile(e.source_file) && !isTestFile(e.target_file));

  if (cfg.filter.kinds) {
    const kinds = new Set(cfg.filter.kinds);
    edges = edges.filter((e) => kinds.has(e.source_kind) && kinds.has(e.target_kind));
  }
  if (cfg.filter.files) {
    const patterns = cfg.filter.files;
    edges = edges.filter(
      (e) =>
        patterns.some((p) => e.source_file.includes(p)) &&
        patterns.some((p) => e.target_file.includes(p)),
    );
  }

  const nodeMap = new Map();
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

  if (cfg.filter.roles) {
    const roles = new Set(cfg.filter.roles);
    for (const [id, n] of nodeMap) {
      if (!roles.has(n.role)) nodeMap.delete(id);
    }
    const nodeIds = new Set(nodeMap.keys());
    edges = edges.filter((e) => nodeIds.has(e.source_id) && nodeIds.has(e.target_id));
  }

  // Complexity data
  const complexityMap = new Map();
  try {
    const rows = db
      .prepare(
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

  // Fan-in / fan-out via graph subsystem
  const fnGraph = new CodeGraph();
  for (const [id] of nodeMap) fnGraph.addNode(String(id));
  for (const e of edges) {
    const src = String(e.source_id);
    const tgt = String(e.target_id);
    if (src !== tgt && !fnGraph.hasEdge(src, tgt)) fnGraph.addEdge(src, tgt);
  }

  // Use DB-level fan-in/fan-out (counts ALL call edges, not just visible)
  const fanInMap = new Map();
  const fanOutMap = new Map();
  const fanInRows = db
    .prepare(
      "SELECT target_id AS node_id, COUNT(*) AS fan_in FROM edges WHERE kind = 'calls' GROUP BY target_id",
    )
    .all();
  for (const r of fanInRows) fanInMap.set(r.node_id, r.fan_in);

  const fanOutRows = db
    .prepare(
      "SELECT source_id AS node_id, COUNT(*) AS fan_out FROM edges WHERE kind = 'calls' GROUP BY source_id",
    )
    .all();
  for (const r of fanOutRows) fanOutMap.set(r.node_id, r.fan_out);

  // Communities (Louvain) via graph subsystem
  const communityMap = new Map();
  if (nodeMap.size > 0) {
    try {
      const { assignments } = louvainCommunities(fnGraph);
      for (const [nid, cid] of assignments) communityMap.set(Number(nid), cid);
    } catch {
      // louvain can fail on disconnected graphs
    }
  }

  // Build enriched nodes
  const visNodes = [...nodeMap.values()].map((n) => {
    const cx = complexityMap.get(n.id) || null;
    const fanIn = fanInMap.get(n.id) || 0;
    const fanOut = fanOutMap.get(n.id) || 0;
    const community = communityMap.get(n.id) ?? null;
    const directory = path.dirname(n.file);
    const risk = [];
    if (n.role === 'dead') risk.push('dead-code');
    if (fanIn >= (cfg.riskThresholds?.highBlastRadius ?? 10)) risk.push('high-blast-radius');
    if (cx && cx.maintainabilityIndex < (cfg.riskThresholds?.lowMI ?? 40)) risk.push('low-mi');

    const color =
      cfg.colorBy === 'role' && n.role
        ? cfg.roleColors[n.role] || DEFAULT_ROLE_COLORS[n.role] || '#ccc'
        : cfg.colorBy === 'community' && community !== null
          ? COMMUNITY_COLORS[community % COMMUNITY_COLORS.length]
          : cfg.nodeColors[n.kind] || DEFAULT_NODE_COLORS[n.kind] || '#ccc';

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
  });

  const visEdges = edges.map((e, i) => ({
    id: `e${i}`,
    from: e.source_id,
    to: e.target_id,
  }));

  // Seed strategy
  let seedNodeIds;
  if (cfg.seedStrategy === 'top-fanin') {
    const sorted = [...visNodes].sort((a, b) => b.fanIn - a.fanIn);
    seedNodeIds = sorted.slice(0, cfg.seedCount || 30).map((n) => n.id);
  } else if (cfg.seedStrategy === 'entry') {
    seedNodeIds = visNodes.filter((n) => n.role === 'entry').map((n) => n.id);
  } else {
    seedNodeIds = visNodes.map((n) => n.id);
  }

  return { nodes: visNodes, edges: visEdges, seedNodeIds };
}

function prepareFileLevelData(db, noTests, minConf, cfg) {
  let edges = db
    .prepare(
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

  const files = new Set();
  for (const { source, target } of edges) {
    files.add(source);
    files.add(target);
  }

  const fileIds = new Map();
  let idx = 0;
  for (const f of files) fileIds.set(f, idx++);

  // Fan-in/fan-out
  const fanInCount = new Map();
  const fanOutCount = new Map();
  for (const { source, target } of edges) {
    fanOutCount.set(source, (fanOutCount.get(source) || 0) + 1);
    fanInCount.set(target, (fanInCount.get(target) || 0) + 1);
  }

  // Communities via graph subsystem
  const communityMap = new Map();
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

  const visNodes = [...files].map((f) => {
    const id = fileIds.get(f);
    const community = communityMap.get(f) ?? null;
    const fanIn = fanInCount.get(f) || 0;
    const fanOut = fanOutCount.get(f) || 0;
    const directory = path.dirname(f);
    const color =
      cfg.colorBy === 'community' && community !== null
        ? COMMUNITY_COLORS[community % COMMUNITY_COLORS.length]
        : cfg.nodeColors.file || DEFAULT_NODE_COLORS.file;

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

  const visEdges = edges.map(({ source, target }, i) => ({
    id: `e${i}`,
    from: fileIds.get(source),
    to: fileIds.get(target),
  }));

  let seedNodeIds;
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

/**
 * Generate a self-contained interactive HTML file with vis-network.
 *
 * Loads graph data from the DB, then delegates to the presentation layer.
 */
export function generatePlotHTML(db, opts = {}) {
  const cfg = opts.config || DEFAULT_CONFIG;
  const data = prepareGraphData(db, opts);
  return renderPlotHTML(data, cfg);
}
