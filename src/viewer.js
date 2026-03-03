import fs from 'node:fs';
import path from 'node:path';
import { isTestFile } from './queries.js';

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

const DEFAULT_CONFIG = {
  layout: { algorithm: 'hierarchical', direction: 'LR' },
  physics: { enabled: true, nodeDistance: 150 },
  nodeColors: DEFAULT_NODE_COLORS,
  roleColors: DEFAULT_ROLE_COLORS,
  colorBy: 'kind',
  edgeStyle: { color: '#666', smooth: true },
  filter: { kinds: null, roles: null, files: null },
  title: 'Codegraph',
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
          nodeColors: { ...DEFAULT_CONFIG.nodeColors, ...(raw.nodeColors || {}) },
          roleColors: { ...DEFAULT_CONFIG.roleColors, ...(raw.roleColors || {}) },
          edgeStyle: { ...DEFAULT_CONFIG.edgeStyle, ...(raw.edgeStyle || {}) },
          filter: { ...DEFAULT_CONFIG.filter, ...(raw.filter || {}) },
        };
      } catch {
        // Invalid JSON — use defaults
      }
    }
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Generate a self-contained interactive HTML file with vis-network.
 */
export function generatePlotHTML(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const cfg = opts.config || DEFAULT_CONFIG;

  let visNodes;
  let visEdges;

  if (fileLevel) {
    let edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
        AND e.confidence >= ?
    `)
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

    visNodes = [...files].map((f) => ({
      id: fileIds.get(f),
      label: path.basename(f),
      title: f,
      color: cfg.nodeColors.file || DEFAULT_NODE_COLORS.file,
    }));

    visEdges = edges.map(({ source, target }) => ({
      from: fileIds.get(source),
      to: fileIds.get(target),
    }));
  } else {
    let edges = db
      .prepare(`
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
    `)
      .all(minConf);
    if (noTests)
      edges = edges.filter((e) => !isTestFile(e.source_file) && !isTestFile(e.target_file));

    // Apply filters
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

    visNodes = [...nodeMap.values()].map((n) => {
      const color =
        cfg.colorBy === 'role' && n.role
          ? cfg.roleColors[n.role] || DEFAULT_ROLE_COLORS[n.role] || '#ccc'
          : cfg.nodeColors[n.kind] || DEFAULT_NODE_COLORS[n.kind] || '#ccc';
      return {
        id: n.id,
        label: n.name,
        title: `${n.file}:${n.line} (${n.kind}${n.role ? `, ${n.role}` : ''})`,
        color,
        kind: n.kind,
        role: n.role || '',
        file: n.file,
      };
    });

    visEdges = edges.map((e) => ({
      from: e.source_id,
      to: e.target_id,
    }));
  }

  const layoutOpts = buildLayoutOptions(cfg);
  const title = cfg.title || 'Codegraph';

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
  #controls select, #controls input { font-size: 13px; padding: 2px 6px; }
  #graph { width: 100%; height: calc(100vh - 80px); }
  #legend { position: absolute; bottom: 12px; right: 12px; background: rgba(255,255,255,0.95); border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; font-size: 12px; }
  #legend div { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  #legend span.swatch { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
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
</div>
<div id="graph"></div>
<div id="legend"></div>
<script>
var graphNodes = ${JSON.stringify(visNodes)};
var graphEdges = ${JSON.stringify(visEdges)};
var nodeColors = ${JSON.stringify(cfg.nodeColors)};

var nodes = new vis.DataSet(graphNodes);
var edges = new vis.DataSet(graphEdges);
var container = document.getElementById('graph');
var data = { nodes: nodes, edges: edges };
var options = ${JSON.stringify(layoutOpts, null, 2)};
var network = new vis.Network(container, data, options);

// Legend
var legend = document.getElementById('legend');
var kinds = {};
graphNodes.forEach(function(n) { if (n.kind) kinds[n.kind] = n.color; });
Object.keys(kinds).sort().forEach(function(k) {
  var d = document.createElement('div');
  d.innerHTML = '<span class="swatch" style="background:' + kinds[k] + '"></span>' + k;
  legend.appendChild(d);
});

// Layout selector
document.getElementById('layoutSelect').addEventListener('change', function(e) {
  var val = e.target.value;
  if (val === 'hierarchical') {
    network.setOptions({ layout: { hierarchical: { enabled: true, direction: '${cfg.layout.direction || 'LR'}' } }, physics: { enabled: document.getElementById('physicsToggle').checked } });
  } else if (val === 'radial') {
    network.setOptions({ layout: { hierarchical: false, improvedLayout: true }, physics: { enabled: true, solver: 'repulsion', repulsion: { nodeDistance: 200 } } });
  } else {
    network.setOptions({ layout: { hierarchical: false }, physics: { enabled: true } });
  }
});

// Physics toggle
document.getElementById('physicsToggle').addEventListener('change', function(e) {
  network.setOptions({ physics: { enabled: e.target.checked } });
});

// Search filter
document.getElementById('searchInput').addEventListener('input', function(e) {
  var q = e.target.value.toLowerCase();
  if (!q) { nodes.update(graphNodes.map(function(n) { return { id: n.id, hidden: false }; })); return; }
  graphNodes.forEach(function(n) {
    var match = n.label.toLowerCase().includes(q) || (n.file && n.file.toLowerCase().includes(q));
    nodes.update({ id: n.id, hidden: !match });
  });
});
</script>
</body>
</html>`;
}

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
