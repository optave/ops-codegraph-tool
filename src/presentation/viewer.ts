import fs from 'node:fs';
import path from 'node:path';
import { debug } from '../infrastructure/logger.js';
import { toErrorMessage } from '../shared/errors.js';
import { COMMUNITY_COLORS, DEFAULT_NODE_COLORS, DEFAULT_ROLE_COLORS } from './colors.js';

// Re-export color constants so existing consumers are unaffected
export { COMMUNITY_COLORS, DEFAULT_NODE_COLORS, DEFAULT_ROLE_COLORS };

export interface PlotConfig {
  layout?: { algorithm?: string; direction?: string };
  physics?: { enabled?: boolean; nodeDistance?: number };
  nodeColors?: Record<string, string>;
  roleColors?: Record<string, string>;
  colorBy?: string;
  edgeStyle?: { color?: string; smooth?: boolean };
  filter?: { kinds?: string[] | null; roles?: string[] | null; files?: string[] | null };
  title?: string;
  seedStrategy?: string;
  seedCount?: number;
  clusterBy?: string;
  sizeBy?: string;
  overlays?: { complexity?: boolean; risk?: boolean };
  riskThresholds?: { highBlastRadius?: number; lowMI?: number };
}

export const DEFAULT_CONFIG: PlotConfig = {
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

// ─── Config Loading ──────────────────────────────────────────────────

export function loadPlotConfig(dir: string): PlotConfig {
  for (const name of ['.plotDotCfg', '.plotDotCfg.json']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<PlotConfig>;
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
      } catch (e) {
        debug(`loadViewerConfig: invalid JSON in config file: ${toErrorMessage(e)}`);
      }
    }
  }
  return { ...DEFAULT_CONFIG };
}

// ─── Internal Helpers ────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface LayoutOptions {
  nodes: { shape: string; font: { face: string; size: number } };
  edges: { arrows: string; color: string; smooth: boolean };
  physics: {
    enabled: boolean;
    barnesHut: { gravitationalConstant: number; springLength: number };
  };
  interaction: { tooltipDelay: number; hover: boolean };
  layout?: {
    hierarchical: {
      enabled: boolean;
      direction: string;
      sortMethod: string;
      nodeSpacing: number;
    };
  };
}

export function buildLayoutOptions(cfg: PlotConfig): LayoutOptions {
  const opts: LayoutOptions = {
    nodes: {
      shape: 'box',
      font: { face: 'monospace', size: 12 },
    },
    edges: {
      arrows: 'to',
      color: cfg.edgeStyle?.color || '#666',
      smooth: cfg.edgeStyle?.smooth !== false,
    },
    physics: {
      enabled: cfg.physics?.enabled !== false,
      barnesHut: {
        gravitationalConstant: -3000,
        springLength: cfg.physics?.nodeDistance || 150,
      },
    },
    interaction: {
      tooltipDelay: 200,
      hover: true,
    },
  };

  if (cfg.layout?.algorithm === 'hierarchical') {
    opts.layout = {
      hierarchical: {
        enabled: true,
        direction: cfg.layout?.direction || 'LR',
        sortMethod: 'directed',
        nodeSpacing: cfg.physics?.nodeDistance || 150,
      },
    };
  }

  return opts;
}

// ─── HTML Renderer ───────────────────────────────────────────────────

export interface ViewerNode {
  id: number | string;
  label: string;
  kind: string;
  file: string;
  line: number;
  role: string | null;
  fanIn: number;
  fanOut: number;
  cognitive: number | null;
  cyclomatic: number | null;
  maintainabilityIndex: number | null;
  community: number | null;
  directory: string | null;
  risk: string[];
}

export interface ViewerEdge {
  id: number | string;
  from: number | string;
  to: number | string;
}

export interface ViewerData {
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  seedNodeIds: (number | string)[];
}

interface ResolvedPlotConfig {
  layoutOpts: LayoutOptions;
  title: string;
  layoutAlgorithm: string;
  layoutDirection: string;
  physicsEnabled: boolean;
  sizeBy: string;
  clusterBy: string;
  effectiveColorBy: string;
  effectiveRisk: boolean;
}

function resolvePlotConfig(cfg: PlotConfig): ResolvedPlotConfig {
  return {
    layoutOpts: buildLayoutOptions(cfg),
    title: cfg.title || 'Codegraph',
    layoutAlgorithm: cfg.layout?.algorithm || 'hierarchical',
    layoutDirection: cfg.layout?.direction || 'LR',
    physicsEnabled: cfg.physics?.enabled !== false,
    sizeBy: cfg.sizeBy || 'uniform',
    clusterBy: cfg.clusterBy || 'none',
    effectiveColorBy:
      cfg.overlays?.complexity && cfg.colorBy === 'kind' ? 'complexity' : cfg.colorBy || 'kind',
    effectiveRisk: cfg.overlays?.risk || false,
  };
}

export function renderPlotHTML(data: ViewerData, cfg: PlotConfig): string {
  const {
    layoutOpts,
    title,
    layoutAlgorithm,
    layoutDirection,
    physicsEnabled,
    sizeBy,
    clusterBy,
    effectiveColorBy,
    effectiveRisk,
  } = resolvePlotConfig(cfg);

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
      <option value="hierarchical"${layoutAlgorithm === 'hierarchical' ? ' selected' : ''}>Hierarchical</option>
      <option value="force"${layoutAlgorithm === 'force' ? ' selected' : ''}>Force</option>
      <option value="radial"${layoutAlgorithm === 'radial' ? ' selected' : ''}>Radial</option>
    </select>
  </label>
  <label>Physics: <input type="checkbox" id="physicsToggle"${physicsEnabled ? ' checked' : ''}></label>
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
      <option value="uniform"${sizeBy === 'uniform' ? ' selected' : ''}>Uniform</option>
      <option value="fan-in"${sizeBy === 'fan-in' ? ' selected' : ''}>Fan-in</option>
      <option value="fan-out"${sizeBy === 'fan-out' ? ' selected' : ''}>Fan-out</option>
      <option value="complexity"${sizeBy === 'complexity' ? ' selected' : ''}>Complexity</option>
    </select>
  </label>
  <label>Cluster by:
    <select id="clusterBySelect">
      <option value="none"${clusterBy === 'none' ? ' selected' : ''}>None</option>
      <option value="community"${clusterBy === 'community' ? ' selected' : ''}>Community</option>
      <option value="directory"${clusterBy === 'directory' ? ' selected' : ''}>Directory</option>
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
    network.setOptions({ layout: { hierarchical: { enabled: true, direction: ${JSON.stringify(layoutDirection)} } }, physics: { enabled: document.getElementById('physicsToggle').checked } });
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
${clusterBy !== 'none' ? `applyClusterBy(${JSON.stringify(clusterBy)});` : ''}
</script>
</body>
</html>`;
}
