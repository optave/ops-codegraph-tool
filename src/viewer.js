import fs from 'node:fs';
import path from 'node:path';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { isTestFile } from './test-filter.js';

const DEFAULT_MIN_CONFIDENCE = 0.5;

const DEFAULT_NODE_COLORS = {
  function: '#4CAF50',
  method: '#66BB6A',
  class: '#2196F3',
  interface: '#42A5F5',
  type: '#7E57C2',
  struct: '#FF7043',
  enum: '#FFA726',
  trait: '#26A69A',
  record: '#EC407A',
  module: '#78909C',
  file: '#90A4AE',
};

const DEFAULT_ROLE_COLORS = {
  entry: '#e8f5e9',
  core: '#e3f2fd',
  utility: '#f5f5f5',
  dead: '#ffebee',
  leaf: '#fffde7',
};

const COMMUNITY_COLORS = [
  '#4CAF50',
  '#2196F3',
  '#FF9800',
  '#9C27B0',
  '#F44336',
  '#00BCD4',
  '#CDDC39',
  '#E91E63',
  '#3F51B5',
  '#FF5722',
  '#009688',
  '#795548',
];

const DEFAULT_CONFIG = {
  layout: { algorithm: 'hierarchical', direction: 'LR' },
  physics: { enabled: true, nodeDistance: 150 },
  nodeColors: DEFAULT_NODE_COLORS,
  roleColors: DEFAULT_ROLE_COLORS,
  colorBy: 'kind',
  edgeStyle: { color: '#666', smooth: true },
  filter: { kinds: null, roles: null, files: null },
  title: 'Codegraph',
  seedStrategy: 'all',
  seedCount: 30,
  clusterBy: 'none',
  sizeBy: 'uniform',
  overlays: { complexity: false, risk: false },
  riskThresholds: { highBlastRadius: 10, lowMI: 40 },
};

/**
 * Load .plotDotCfg or .plotDotCfg.json from given directory.
 * Returns merged config with defaults.
 */
export function loadPlotConfig(dir) {
  for (const name of ['.plotDotCfg', '.plotDotCfg.json']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return {
          ...DEFAULT_CONFIG,
          ...raw,
          layout: { ...DEFAULT_CONFIG.layout, ...(raw.layout || {}) },
          physics: { ...DEFAULT_CONFIG.physics, ...(raw.physics || {}) },
          nodeColors: {
            ...DEFAULT_CONFIG.nodeColors,
            ...(raw.nodeColors || {}),
          },
          roleColors: {
            ...DEFAULT_CONFIG.roleColors,
            ...(raw.roleColors || {}),
          },
          edgeStyle: {
            ...DEFAULT_CONFIG.edgeStyle,
            ...(raw.edgeStyle || {}),
          },
          filter: { ...DEFAULT_CONFIG.filter, ...(raw.filter || {}) },
          overlays: {
            ...DEFAULT_CONFIG.overlays,
            ...(raw.overlays || {}),
          },
          riskThresholds: {
            ...DEFAULT_CONFIG.riskThresholds,
            ...(raw.riskThresholds || {}),
          },
        };
      } catch {
        // Invalid JSON — use defaults
      }
    }
  }
  return { ...DEFAULT_CONFIG };
}

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

  // Fan-in / fan-out
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

  // Communities (Louvain)
  const communityMap = new Map();
  if (nodeMap.size > 0) {
    try {
      const graph = new Graph({ type: 'undirected' });
      for (const [id] of nodeMap) graph.addNode(String(id));
      for (const e of edges) {
        const src = String(e.source_id);
        const tgt = String(e.target_id);
        if (src !== tgt && !graph.hasEdge(src, tgt)) graph.addEdge(src, tgt);
      }
      const communities = louvain(graph);
      for (const [nid, cid] of Object.entries(communities)) communityMap.set(Number(nid), cid);
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

  // Communities
  const communityMap = new Map();
  if (files.size > 0) {
    try {
      const graph = new Graph({ type: 'undirected' });
      for (const f of files) graph.addNode(f);
      for (const { source, target } of edges) {
        if (source !== target && !graph.hasEdge(source, target)) graph.addEdge(source, target);
      }
      const communities = louvain(graph);
      for (const [file, cid] of Object.entries(communities)) communityMap.set(file, cid);
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

// ─── HTML Generation ──────────────────────────────────────────────────

/**
 * Generate a self-contained interactive HTML file with vis-network.
 */
export function generatePlotHTML(db, opts = {}) {
  const cfg = opts.config || DEFAULT_CONFIG;
  const data = prepareGraphData(db, opts);
  const layoutOpts = buildLayoutOptions(cfg);
  const title = cfg.title || 'Codegraph';

  // Resolve effective colorBy (overlays.complexity overrides)
  const effectiveColorBy =
    cfg.overlays?.complexity && cfg.colorBy === 'kind' ? 'complexity' : cfg.colorBy || 'kind';
  const effectiveRisk = cfg.overlays?.risk || false;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: monospace; background: #fafafa; }
  #controls { padding: 8px 12px; background: #fff; border-bottom: 1px solid #ddd; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  #controls label { font-size: 13px; }
  #controls select, #controls input[type="text"] { font-size: 13px; padding: 2px 6px; }
  #main { display: flex; height: calc(100vh - 44px); }
  #graph { flex: 1; }
  #detail { width: 320px; border-left: 1px solid #ddd; background: #fff; overflow-y: auto; display: none; padding: 12px; font-size: 13px; }
  #detail h3 { margin-bottom: 6px; word-break: break-all; }
  #detailClose { float: right; cursor: pointer; font-size: 18px; color: #999; line-height: 1; }
  #detailClose:hover { color: #333; }
  .detail-meta { margin-bottom: 4px; }
  .detail-file { color: #666; margin-bottom: 10px; font-size: 12px; }
  .detail-section { margin-bottom: 10px; }
  .detail-section table { width: 100%; border-collapse: collapse; }
  .detail-section td { padding: 2px 8px 2px 0; }
  .detail-section ul { list-style: none; padding: 0; }
  .detail-section li { padding: 2px 0; }
  .detail-section a { color: #1976D2; text-decoration: none; cursor: pointer; }
  .detail-section a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-right: 4px; }
  .kind-badge { background: #E3F2FD; color: #1565C0; }
  .role-badge { background: #E8F5E9; color: #2E7D32; }
  .risk-badge { background: #FFEBEE; color: #C62828; }
  #legend { position: absolute; bottom: 12px; right: 12px; background: rgba(255,255,255,0.95); border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; font-size: 12px; max-height: 300px; overflow-y: auto; }
  #legend div { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  #legend span.swatch { width: 14px; height: 14px; border-radius: 3px; display: inline-block; flex-shrink: 0; }
</style>
</head>
<body>
<div id="controls">
  <label>Layout:
    <select id="layoutSelect">
      <option value="hierarchical"${cfg.layout.algorithm === 'hierarchical' ? ' selected' : ''}>Hierarchical</option>
      <option value="force"${cfg.layout.algorithm === 'force' ? ' selected' : ''}>Force</option>
      <option value="radial"${cfg.layout.algorithm === 'radial' ? ' selected' : ''}>Radial</option>
    </select>
  </label>
  <label>Physics: <input type="checkbox" id="physicsToggle"${cfg.physics.enabled ? ' checked' : ''}></label>
  <label>Search: <input type="text" id="searchInput" placeholder="Filter nodes..."></label>
  <label>Color by:
    <select id="colorBySelect">
      <option value="kind"${effectiveColorBy === 'kind' ? ' selected' : ''}>Kind</option>
      <option value="role"${effectiveColorBy === 'role' ? ' selected' : ''}>Role</option>
      <option value="community"${effectiveColorBy === 'community' ? ' selected' : ''}>Community</option>
      <option value="complexity"${effectiveColorBy === 'complexity' ? ' selected' : ''}>Complexity</option>
    </select>
  </label>
  <label>Size by:
    <select id="sizeBySelect">
      <option value="uniform"${(cfg.sizeBy || 'uniform') === 'uniform' ? ' selected' : ''}>Uniform</option>
      <option value="fan-in"${cfg.sizeBy === 'fan-in' ? ' selected' : ''}>Fan-in</option>
      <option value="fan-out"${cfg.sizeBy === 'fan-out' ? ' selected' : ''}>Fan-out</option>
      <option value="complexity"${cfg.sizeBy === 'complexity' ? ' selected' : ''}>Complexity</option>
    </select>
  </label>
  <label>Cluster by:
    <select id="clusterBySelect">
      <option value="none"${(cfg.clusterBy || 'none') === 'none' ? ' selected' : ''}>None</option>
      <option value="community"${cfg.clusterBy === 'community' ? ' selected' : ''}>Community</option>
      <option value="directory"${cfg.clusterBy === 'directory' ? ' selected' : ''}>Directory</option>
    </select>
  </label>
  <label>Risk: <input type="checkbox" id="riskToggle"${effectiveRisk ? ' checked' : ''}></label>
</div>
<div id="main">
  <div id="graph"></div>
  <div id="detail">
    <span id="detailClose">&times;</span>
    <div id="detailContent"></div>
  </div>
</div>
<div id="legend"></div>
<script>
/* ── Data ──────────────────────────────────────────────────────────── */
var allNodes = ${JSON.stringify(data.nodes)};
var allEdges = ${JSON.stringify(data.edges)};
var seedNodeIds = ${JSON.stringify(data.seedNodeIds)};
var nodeColorMap = ${JSON.stringify(cfg.nodeColors || DEFAULT_NODE_COLORS)};
var roleColorMap = ${JSON.stringify(cfg.roleColors || DEFAULT_ROLE_COLORS)};
var communityColors = ${JSON.stringify(COMMUNITY_COLORS)};

/* ── Lookups ───────────────────────────────────────────────────────── */
var nodeById = {};
allNodes.forEach(function(n) { nodeById[n.id] = n; });
var adjIndex = {};
allNodes.forEach(function(n) { adjIndex[n.id] = { callers: [], callees: [] }; });
allEdges.forEach(function(e) {
  if (adjIndex[e.from]) adjIndex[e.from].callees.push(e.to);
  if (adjIndex[e.to]) adjIndex[e.to].callers.push(e.from);
});

/* ── State ─────────────────────────────────────────────────────────── */
var seedSet = new Set(seedNodeIds);
var visibleNodeIds = new Set(seedNodeIds);
var expandedNodes = new Set();
var drillDownActive = ${JSON.stringify((cfg.seedStrategy || 'all') !== 'all')};

/* ── Helpers ───────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── vis-network init ──────────────────────────────────────────────── */
function getVisibleNodes() {
  return allNodes.filter(function(n) { return visibleNodeIds.has(n.id); });
}
function getVisibleEdges() {
  return allEdges.filter(function(e) { return visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to); });
}

var nodes = new vis.DataSet(getVisibleNodes());
var edges = new vis.DataSet(getVisibleEdges());
var container = document.getElementById('graph');
var options = ${JSON.stringify(layoutOpts, null, 2)};
var network = new vis.Network(container, { nodes: nodes, edges: edges }, options);

/* ── Appearance ────────────────────────────────────────────────────── */
function refreshNodeAppearance() {
  var colorBy = document.getElementById('colorBySelect').value;
  var sizeBy = document.getElementById('sizeBySelect').value;
  var riskEnabled = document.getElementById('riskToggle').checked;
  var updates = [];

  allNodes.forEach(function(n) {
    if (!visibleNodeIds.has(n.id)) return;
    var update = { id: n.id };

    // Background color
    var bg;
    if (colorBy === 'role') {
      bg = n.role ? (roleColorMap[n.role] || nodeColorMap[n.kind] || '#ccc') : (nodeColorMap[n.kind] || '#ccc');
    } else if (colorBy === 'community') {
      bg = n.community !== null ? communityColors[n.community % communityColors.length] : '#ccc';
    } else {
      bg = nodeColorMap[n.kind] || '#ccc';
    }

    var borderColor = '#888';
    var borderWidth = 1;
    var borderDashes = false;
    var shadow = false;

    // Complexity border (when colorBy is 'complexity')
    if (colorBy === 'complexity' && n.maintainabilityIndex !== null) {
      var mi = n.maintainabilityIndex;
      if (mi >= 80) { borderColor = '#4CAF50'; borderWidth = 2; }
      else if (mi >= 65) { borderColor = '#FFC107'; borderWidth = 3; }
      else if (mi >= 40) { borderColor = '#FF9800'; borderWidth = 3; }
      else { borderColor = '#F44336'; borderWidth = 4; }
    }

    // Risk overlay (overrides border when active)
    if (riskEnabled && n.risk && n.risk.length > 0) {
      if (n.risk.indexOf('dead-code') >= 0) {
        borderColor = '#F44336'; borderDashes = [5, 5]; borderWidth = 3;
      }
      if (n.risk.indexOf('high-blast-radius') >= 0) {
        borderColor = '#FF9800'; shadow = true; borderWidth = 3;
      }
      if (n.risk.indexOf('low-mi') >= 0) {
        borderColor = '#FF9800'; borderWidth = 3;
      }
    }

    update.color = { background: bg, border: borderColor };
    update.borderWidth = borderWidth;
    update.borderDashes = borderDashes;
    update.shadow = shadow;

    // Size
    if (sizeBy === 'fan-in') {
      update.size = 15 + Math.min(n.fanIn || 0, 30) * 2;
      update.shape = 'dot';
    } else if (sizeBy === 'fan-out') {
      update.size = 15 + Math.min(n.fanOut || 0, 30) * 2;
      update.shape = 'dot';
    } else if (sizeBy === 'complexity') {
      update.size = 15 + Math.min(n.cyclomatic || 0, 20) * 3;
      update.shape = 'dot';
    } else {
      update.shape = 'box';
    }

    updates.push(update);
  });

  nodes.update(updates);
}

/* ── Clustering ────────────────────────────────────────────────────── */
function applyClusterBy(mode) {
  // Open all existing clusters first
  var ids = nodes.getIds();
  for (var i = 0; i < ids.length; i++) {
    if (network.isCluster(ids[i])) {
      try { network.openCluster(ids[i]); } catch(e) { /* ignore */ }
    }
  }

  if (mode === 'none') return;

  if (mode === 'community') {
    var communities = {};
    allNodes.forEach(function(n) {
      if (n.community !== null && visibleNodeIds.has(n.id)) {
        if (!communities[n.community]) communities[n.community] = [];
        communities[n.community].push(n.id);
      }
    });
    Object.keys(communities).forEach(function(cid) {
      if (communities[cid].length < 2) return;
      var cidNum = parseInt(cid, 10);
      network.cluster({
        joinCondition: function(opts) { return opts.community === cidNum; },
        clusterNodeProperties: {
          label: 'Community ' + cid,
          shape: 'diamond',
          color: communityColors[cidNum % communityColors.length]
        }
      });
    });
  } else if (mode === 'directory') {
    var dirs = {};
    allNodes.forEach(function(n) {
      if (visibleNodeIds.has(n.id)) {
        var d = n.directory || '(root)';
        if (!dirs[d]) dirs[d] = [];
        dirs[d].push(n.id);
      }
    });
    Object.keys(dirs).forEach(function(dir) {
      if (dirs[dir].length < 2) return;
      network.cluster({
        joinCondition: function(opts) { return (opts.directory || '(root)') === dir; },
        clusterNodeProperties: {
          label: dir,
          shape: 'diamond',
          color: '#B0BEC5'
        }
      });
    });
  }
}

/* ── Detail Panel ──────────────────────────────────────────────────── */
function showDetail(nodeId) {
  var n = nodeById[nodeId];
  if (!n) { hideDetail(); return; }
  var adj = adjIndex[nodeId] || { callers: [], callees: [] };

  var h = '<h3>' + escHtml(n.label) + '</h3>';
  h += '<div class="detail-meta">';
  h += '<span class="badge kind-badge">' + escHtml(n.kind) + '</span>';
  if (n.role) h += '<span class="badge role-badge">' + escHtml(n.role) + '</span>';
  h += '</div>';
  h += '<div class="detail-file">' + escHtml(n.file) + ':' + n.line + '</div>';

  h += '<div class="detail-section"><strong>Metrics</strong><table>';
  h += '<tr><td>Fan-in</td><td>' + n.fanIn + '</td></tr>';
  h += '<tr><td>Fan-out</td><td>' + n.fanOut + '</td></tr>';
  if (n.cognitive !== null) h += '<tr><td>Cognitive</td><td>' + n.cognitive + '</td></tr>';
  if (n.cyclomatic !== null) h += '<tr><td>Cyclomatic</td><td>' + n.cyclomatic + '</td></tr>';
  if (n.maintainabilityIndex !== null) h += '<tr><td>MI</td><td>' + n.maintainabilityIndex.toFixed(1) + '</td></tr>';
  h += '</table></div>';

  if (n.risk && n.risk.length > 0) {
    h += '<div class="detail-section"><strong>Risk</strong><br>';
    n.risk.forEach(function(r) { h += '<span class="badge risk-badge">' + escHtml(r) + '</span>'; });
    h += '</div>';
  }

  if (adj.callers.length > 0) {
    h += '<div class="detail-section"><strong>Callers (' + adj.callers.length + ')</strong><ul>';
    adj.callers.forEach(function(cid) {
      var c = nodeById[cid];
      if (c) h += '<li><a onclick="focusNode(' + cid + ')">' + escHtml(c.label) + '</a></li>';
    });
    h += '</ul></div>';
  }

  if (adj.callees.length > 0) {
    h += '<div class="detail-section"><strong>Callees (' + adj.callees.length + ')</strong><ul>';
    adj.callees.forEach(function(cid) {
      var c = nodeById[cid];
      if (c) h += '<li><a onclick="focusNode(' + cid + ')">' + escHtml(c.label) + '</a></li>';
    });
    h += '</ul></div>';
  }

  document.getElementById('detailContent').innerHTML = h;
  document.getElementById('detail').style.display = 'block';
}

function hideDetail() {
  document.getElementById('detail').style.display = 'none';
}

function focusNode(nodeId) {
  if (drillDownActive && !visibleNodeIds.has(nodeId)) expandNode(nodeId);
  network.focus(nodeId, { scale: 1.2, animation: true });
  network.selectNodes([nodeId]);
  showDetail(nodeId);
}

/* ── Drill-down ────────────────────────────────────────────────────── */
function expandNode(nodeId) {
  if (!drillDownActive) return;
  expandedNodes.add(nodeId);
  var adj = adjIndex[nodeId] || { callers: [], callees: [] };
  var newNodeData = [];
  adj.callers.concat(adj.callees).forEach(function(nid) {
    if (!visibleNodeIds.has(nid)) {
      visibleNodeIds.add(nid);
      var n = nodeById[nid];
      if (n) newNodeData.push(n);
    }
  });
  if (newNodeData.length > 0) {
    nodes.add(newNodeData);
    var newEdges = allEdges.filter(function(e) {
      return visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to) && !edges.get(e.id);
    });
    if (newEdges.length > 0) edges.add(newEdges);
    refreshNodeAppearance();
  }
}

function collapseNode(nodeId) {
  if (!drillDownActive) return;
  expandedNodes.delete(nodeId);
  recalculateVisibility();
}

function recalculateVisibility() {
  var newVisible = new Set(seedSet);
  expandedNodes.forEach(function(nid) {
    newVisible.add(nid);
    var adj = adjIndex[nid] || { callers: [], callees: [] };
    adj.callers.concat(adj.callees).forEach(function(id) { newVisible.add(id); });
  });

  var toRemove = [];
  visibleNodeIds.forEach(function(id) { if (!newVisible.has(id)) toRemove.push(id); });
  if (toRemove.length > 0) nodes.remove(toRemove);

  var toAdd = [];
  newVisible.forEach(function(id) {
    if (!visibleNodeIds.has(id) && nodeById[id]) toAdd.push(nodeById[id]);
  });
  if (toAdd.length > 0) nodes.add(toAdd);

  visibleNodeIds = newVisible;
  edges.clear();
  edges.add(allEdges.filter(function(e) {
    return visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to);
  }));
  refreshNodeAppearance();
}

/* ── Legend ─────────────────────────────────────────────────────────── */
function updateLegend(colorBy) {
  var legend = document.getElementById('legend');
  legend.innerHTML = '';
  var items = {};

  if (colorBy === 'kind') {
    allNodes.forEach(function(n) { if (n.kind && visibleNodeIds.has(n.id)) items[n.kind] = nodeColorMap[n.kind] || '#ccc'; });
  } else if (colorBy === 'role') {
    allNodes.forEach(function(n) {
      if (visibleNodeIds.has(n.id)) {
        var key = n.role || n.kind;
        items[key] = n.role ? (roleColorMap[n.role] || '#ccc') : (nodeColorMap[n.kind] || '#ccc');
      }
    });
  } else if (colorBy === 'community') {
    allNodes.forEach(function(n) {
      if (n.community !== null && visibleNodeIds.has(n.id)) {
        items['Community ' + n.community] = communityColors[n.community % communityColors.length];
      }
    });
  } else if (colorBy === 'complexity') {
    items['MI >= 80'] = '#4CAF50';
    items['MI 65-80'] = '#FFC107';
    items['MI 40-65'] = '#FF9800';
    items['MI < 40'] = '#F44336';
  }

  Object.keys(items).sort().forEach(function(k) {
    var d = document.createElement('div');
    d.innerHTML = '<span class="swatch" style="background:' + items[k] + '"></span>' + escHtml(k);
    legend.appendChild(d);
  });
}

/* ── Network Events ────────────────────────────────────────────────── */
network.on('click', function(params) {
  if (params.nodes.length === 1) {
    var nodeId = params.nodes[0];
    if (network.isCluster(nodeId)) {
      network.openCluster(nodeId);
      return;
    }
    if (drillDownActive && !expandedNodes.has(nodeId)) expandNode(nodeId);
    showDetail(nodeId);
  } else {
    hideDetail();
  }
});

network.on('doubleClick', function(params) {
  if (params.nodes.length === 1) {
    var nodeId = params.nodes[0];
    if (network.isCluster(nodeId)) return;
    if (drillDownActive && expandedNodes.has(nodeId)) collapseNode(nodeId);
  }
});

/* ── Control Events ────────────────────────────────────────────────── */
document.getElementById('layoutSelect').addEventListener('change', function(e) {
  var val = e.target.value;
  if (val === 'hierarchical') {
    network.setOptions({ layout: { hierarchical: { enabled: true, direction: ${JSON.stringify(cfg.layout.direction || 'LR')} } }, physics: { enabled: document.getElementById('physicsToggle').checked } });
  } else if (val === 'radial') {
    network.setOptions({ layout: { hierarchical: false, improvedLayout: true }, physics: { enabled: true, solver: 'repulsion', repulsion: { nodeDistance: 200 } } });
  } else {
    network.setOptions({ layout: { hierarchical: false }, physics: { enabled: true } });
  }
});

document.getElementById('physicsToggle').addEventListener('change', function(e) {
  network.setOptions({ physics: { enabled: e.target.checked } });
});

document.getElementById('searchInput').addEventListener('input', function(e) {
  var q = e.target.value.toLowerCase();
  if (!q) {
    nodes.update(getVisibleNodes().map(function(n) { return { id: n.id, hidden: false }; }));
    return;
  }
  getVisibleNodes().forEach(function(n) {
    var match = n.label.toLowerCase().includes(q) || (n.file && n.file.toLowerCase().includes(q));
    nodes.update({ id: n.id, hidden: !match });
  });
});

document.getElementById('colorBySelect').addEventListener('change', function() {
  refreshNodeAppearance();
  updateLegend(document.getElementById('colorBySelect').value);
});

document.getElementById('sizeBySelect').addEventListener('change', function() {
  refreshNodeAppearance();
});

document.getElementById('clusterBySelect').addEventListener('change', function(e) {
  applyClusterBy(e.target.value);
});

document.getElementById('riskToggle').addEventListener('change', function() {
  refreshNodeAppearance();
});

document.getElementById('detailClose').addEventListener('click', hideDetail);

/* ── Init ──────────────────────────────────────────────────────────── */
refreshNodeAppearance();
updateLegend(${JSON.stringify(effectiveColorBy)});
${(cfg.clusterBy || 'none') !== 'none' ? `applyClusterBy(${JSON.stringify(cfg.clusterBy)});` : ''}
</script>
</body>
</html>`;
}

// ─── Internal Helpers ─────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildLayoutOptions(cfg) {
  const opts = {
    nodes: {
      shape: 'box',
      font: { face: 'monospace', size: 12 },
    },
    edges: {
      arrows: 'to',
      color: cfg.edgeStyle.color || '#666',
      smooth: cfg.edgeStyle.smooth !== false,
    },
    physics: {
      enabled: cfg.physics.enabled !== false,
      barnesHut: {
        gravitationalConstant: -3000,
        springLength: cfg.physics.nodeDistance || 150,
      },
    },
    interaction: {
      tooltipDelay: 200,
      hover: true,
    },
  };

  if (cfg.layout.algorithm === 'hierarchical') {
    opts.layout = {
      hierarchical: {
        enabled: true,
        direction: cfg.layout.direction || 'LR',
        sortMethod: 'directed',
        nodeSpacing: cfg.physics.nodeDistance || 150,
      },
    };
  }

  return opts;
}
