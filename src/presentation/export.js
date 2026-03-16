/**
 * Graph export serializers — pure data → formatted string transforms.
 *
 * Each function receives pre-loaded graph data and returns a formatted string
 * (or structured object for CSV). No DB access — all data must be pre-loaded.
 */

import path from 'node:path';

// ─── Escape Helpers ──────────────────────────────────────────────────

/** Escape special XML characters. */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC 4180 CSV field escaping — quote fields containing commas, quotes, or newlines. */
export function escapeCsv(s) {
  const str = String(s);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Escape double quotes for Mermaid labels. */
export function escapeLabel(label) {
  return label.replace(/"/g, '#quot;');
}

/** Map node kind to Mermaid shape wrapper. */
export function mermaidShape(kind, label) {
  const escaped = escapeLabel(label);
  switch (kind) {
    case 'function':
    case 'method':
      return `(["${escaped}"])`;
    case 'class':
    case 'interface':
    case 'type':
    case 'struct':
    case 'enum':
    case 'trait':
    case 'record':
      return `{{"${escaped}"}}`;
    case 'module':
      return `[["${escaped}"]]`;
    default:
      return `["${escaped}"]`;
  }
}

/** Map node role to Mermaid style colors. */
export const ROLE_STYLES = {
  entry: 'fill:#e8f5e9,stroke:#4caf50',
  core: 'fill:#e3f2fd,stroke:#2196f3',
  utility: 'fill:#f5f5f5,stroke:#9e9e9e',
  dead: 'fill:#ffebee,stroke:#f44336',
  leaf: 'fill:#fffde7,stroke:#fdd835',
};

// ─── DOT Serializer ──────────────────────────────────────────────────

/**
 * Render file-level graph data as DOT (Graphviz) format.
 *
 * @param {{ dirs: Array<{ name: string, files: Array<{ path: string, basename: string }>, cohesion: number|null }>, edges: Array<{ source: string, target: string }>, totalEdges: number, limit?: number }} data
 * @returns {string}
 */
export function renderFileLevelDOT(data) {
  const lines = [
    'digraph codegraph {',
    '  rankdir=LR;',
    '  node [shape=box, fontname="monospace", fontsize=10];',
    '  edge [color="#666666"];',
    '',
  ];

  let clusterIdx = 0;
  for (const dir of data.dirs) {
    lines.push(`  subgraph cluster_${clusterIdx++} {`);
    const cohLabel = dir.cohesion !== null ? ` (cohesion: ${dir.cohesion.toFixed(2)})` : '';
    lines.push(`    label="${dir.name}${cohLabel}";`);
    lines.push(`    style=dashed;`);
    lines.push(`    color="#999999";`);
    for (const f of dir.files) {
      lines.push(`    "${f.path}" [label="${f.basename}"];`);
    }
    lines.push(`  }`);
    lines.push('');
  }

  for (const { source, target } of data.edges) {
    lines.push(`  "${source}" -> "${target}";`);
  }
  if (data.limit && data.totalEdges > data.limit) {
    lines.push(`  // Truncated: showing ${data.edges.length} of ${data.totalEdges} edges`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Render function-level graph data as DOT (Graphviz) format.
 *
 * @param {{ edges: Array<{ source_name: string, source_file: string, target_name: string, target_file: string }>, totalEdges: number, limit?: number }} data
 * @returns {string}
 */
export function renderFunctionLevelDOT(data) {
  const lines = [
    'digraph codegraph {',
    '  rankdir=LR;',
    '  node [shape=box, fontname="monospace", fontsize=10];',
    '  edge [color="#666666"];',
    '',
  ];

  const emittedNodes = new Set();
  for (const e of data.edges) {
    const sId = `${e.source_file}:${e.source_name}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const tId = `${e.target_file}:${e.target_name}`.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!emittedNodes.has(sId)) {
      lines.push(`  ${sId} [label="${e.source_name}\\n${path.basename(e.source_file)}"];`);
      emittedNodes.add(sId);
    }
    if (!emittedNodes.has(tId)) {
      lines.push(`  ${tId} [label="${e.target_name}\\n${path.basename(e.target_file)}"];`);
      emittedNodes.add(tId);
    }
    lines.push(`  ${sId} -> ${tId};`);
  }
  if (data.limit && data.totalEdges > data.limit) {
    lines.push(`  // Truncated: showing ${data.edges.length} of ${data.totalEdges} edges`);
  }

  lines.push('}');
  return lines.join('\n');
}

// ─── Mermaid Serializer ──────────────────────────────────────────────

/**
 * Render file-level graph data as Mermaid flowchart format.
 *
 * @param {{ direction: string, dirs: Array<{ name: string, files: string[] }>, edges: Array<{ source: string, target: string, edge_kind: string }>, totalEdges: number, limit?: number }} data
 * @returns {string}
 */
export function renderFileLevelMermaid(data) {
  const lines = [`flowchart ${data.direction || 'LR'}`];

  let nodeCounter = 0;
  const nodeIdMap = new Map();
  function nodeId(key) {
    if (!nodeIdMap.has(key)) nodeIdMap.set(key, `n${nodeCounter++}`);
    return nodeIdMap.get(key);
  }

  // Emit subgraphs
  for (const dir of data.dirs) {
    const sgId = dir.name.replace(/[^a-zA-Z0-9]/g, '_');
    lines.push(`  subgraph ${sgId}["${escapeLabel(dir.name)}"]`);
    for (const f of dir.files) {
      const nId = nodeId(f);
      lines.push(`    ${nId}["${escapeLabel(path.basename(f))}"]`);
    }
    lines.push('  end');
  }

  // Deduplicate edges per source-target pair, collecting all distinct kinds
  const edgeMap = new Map();
  for (const { source, target, edge_kind } of data.edges) {
    const key = `${source}|${target}`;
    const label = edge_kind === 'imports-type' ? 'imports' : edge_kind;
    if (!edgeMap.has(key)) edgeMap.set(key, { source, target, labels: new Set() });
    edgeMap.get(key).labels.add(label);
  }

  for (const { source, target, labels } of edgeMap.values()) {
    lines.push(`  ${nodeId(source)} -->|${[...labels].join(', ')}| ${nodeId(target)}`);
  }
  if (data.limit && data.totalEdges > data.limit) {
    lines.push(`  %% Truncated: showing ${data.edges.length} of ${data.totalEdges} edges`);
  }

  return lines.join('\n');
}

/**
 * Render function-level graph data as Mermaid flowchart format.
 *
 * @param {{ direction: string, edges: Array, roles: Map<string, string>, totalEdges: number, limit?: number }} data
 * @returns {string}
 */
export function renderFunctionLevelMermaid(data) {
  const lines = [`flowchart ${data.direction || 'LR'}`];

  let nodeCounter = 0;
  const nodeIdMap = new Map();
  function nodeId(key) {
    if (!nodeIdMap.has(key)) nodeIdMap.set(key, `n${nodeCounter++}`);
    return nodeIdMap.get(key);
  }

  // Group nodes by file for subgraphs
  const fileNodes = new Map();
  const nodeKinds = new Map();
  for (const e of data.edges) {
    const sKey = `${e.source_file}::${e.source_name}`;
    const tKey = `${e.target_file}::${e.target_name}`;
    nodeId(sKey);
    nodeId(tKey);
    nodeKinds.set(sKey, e.source_kind);
    nodeKinds.set(tKey, e.target_kind);

    if (!fileNodes.has(e.source_file)) fileNodes.set(e.source_file, new Map());
    fileNodes.get(e.source_file).set(sKey, e.source_name);

    if (!fileNodes.has(e.target_file)) fileNodes.set(e.target_file, new Map());
    fileNodes.get(e.target_file).set(tKey, e.target_name);
  }

  // Emit subgraphs grouped by file
  for (const [file, nodes] of [...fileNodes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sgId = file.replace(/[^a-zA-Z0-9]/g, '_');
    lines.push(`  subgraph ${sgId}["${escapeLabel(file)}"]`);
    for (const [key, name] of nodes) {
      const kind = nodeKinds.get(key);
      lines.push(`    ${nodeId(key)}${mermaidShape(kind, name)}`);
    }
    lines.push('  end');
  }

  // Emit edges with labels
  for (const e of data.edges) {
    const sId = nodeId(`${e.source_file}::${e.source_name}`);
    const tId = nodeId(`${e.target_file}::${e.target_name}`);
    lines.push(`  ${sId} -->|${e.edge_kind}| ${tId}`);
  }
  if (data.limit && data.totalEdges > data.limit) {
    lines.push(`  %% Truncated: showing ${data.edges.length} of ${data.totalEdges} edges`);
  }

  // Role styling
  const roleStyles = [];
  for (const [key, nid] of nodeIdMap) {
    const role = data.roles?.get(key);
    if (role && ROLE_STYLES[role]) {
      roleStyles.push(`  style ${nid} ${ROLE_STYLES[role]}`);
    }
  }
  lines.push(...roleStyles);

  return lines.join('\n');
}

// ─── GraphML Serializer ──────────────────────────────────────────────

/**
 * Render file-level graph data as GraphML (XML) format.
 *
 * @param {{ edges: Array<{ source: string, target: string }> }} data
 * @returns {string}
 */
export function renderFileLevelGraphML(data) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphstruct.net/graphml">',
    '  <key id="d0" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="d1" for="node" attr.name="file" attr.type="string"/>',
    '  <key id="d2" for="edge" attr.name="kind" attr.type="string"/>',
    '  <graph id="codegraph" edgedefault="directed">',
  ];

  const files = new Set();
  for (const { source, target } of data.edges) {
    files.add(source);
    files.add(target);
  }

  const fileIds = new Map();
  let nIdx = 0;
  for (const f of files) {
    const id = `n${nIdx++}`;
    fileIds.set(f, id);
    lines.push(`    <node id="${id}">`);
    lines.push(`      <data key="d0">${escapeXml(path.basename(f))}</data>`);
    lines.push(`      <data key="d1">${escapeXml(f)}</data>`);
    lines.push('    </node>');
  }

  let eIdx = 0;
  for (const { source, target } of data.edges) {
    lines.push(
      `    <edge id="e${eIdx++}" source="${fileIds.get(source)}" target="${fileIds.get(target)}">`,
    );
    lines.push('      <data key="d2">imports</data>');
    lines.push('    </edge>');
  }

  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n');
}

/**
 * Render function-level graph data as GraphML (XML) format.
 *
 * @param {{ edges: Array }} data
 * @returns {string}
 */
export function renderFunctionLevelGraphML(data) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphstruct.net/graphml">',
    '  <key id="d0" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="d1" for="node" attr.name="kind" attr.type="string"/>',
    '  <key id="d2" for="node" attr.name="file" attr.type="string"/>',
    '  <key id="d3" for="node" attr.name="line" attr.type="int"/>',
    '  <key id="d4" for="node" attr.name="role" attr.type="string"/>',
    '  <key id="d5" for="edge" attr.name="kind" attr.type="string"/>',
    '  <key id="d6" for="edge" attr.name="confidence" attr.type="double"/>',
    '  <graph id="codegraph" edgedefault="directed">',
  ];

  const emittedNodes = new Set();
  function emitNode(id, name, kind, file, line, role) {
    if (emittedNodes.has(id)) return;
    emittedNodes.add(id);
    lines.push(`    <node id="n${id}">`);
    lines.push(`      <data key="d0">${escapeXml(name)}</data>`);
    lines.push(`      <data key="d1">${escapeXml(kind)}</data>`);
    lines.push(`      <data key="d2">${escapeXml(file)}</data>`);
    lines.push(`      <data key="d3">${line}</data>`);
    if (role) lines.push(`      <data key="d4">${escapeXml(role)}</data>`);
    lines.push('    </node>');
  }

  let eIdx = 0;
  for (const e of data.edges) {
    emitNode(
      e.source_id,
      e.source_name,
      e.source_kind,
      e.source_file,
      e.source_line,
      e.source_role,
    );
    emitNode(
      e.target_id,
      e.target_name,
      e.target_kind,
      e.target_file,
      e.target_line,
      e.target_role,
    );
    lines.push(`    <edge id="e${eIdx++}" source="n${e.source_id}" target="n${e.target_id}">`);
    lines.push(`      <data key="d5">${escapeXml(e.edge_kind)}</data>`);
    lines.push(`      <data key="d6">${e.confidence}</data>`);
    lines.push('    </edge>');
  }

  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n');
}

// ─── Neo4j CSV Serializer ────────────────────────────────────────────

/**
 * Render file-level graph data as Neo4j bulk-import CSV.
 *
 * @param {{ edges: Array<{ source: string, target: string, edge_kind: string, confidence: number }> }} data
 * @returns {{ nodes: string, relationships: string }}
 */
export function renderFileLevelNeo4jCSV(data) {
  const files = new Map();
  let idx = 0;
  for (const { source, target } of data.edges) {
    if (!files.has(source)) files.set(source, idx++);
    if (!files.has(target)) files.set(target, idx++);
  }

  const nodeLines = ['nodeId:ID,name,file:string,:LABEL'];
  for (const [file, id] of files) {
    nodeLines.push(`${id},${escapeCsv(path.basename(file))},${escapeCsv(file)},File`);
  }

  const relLines = [':START_ID,:END_ID,:TYPE,confidence:float'];
  for (const e of data.edges) {
    const edgeType = e.edge_kind.toUpperCase().replace(/-/g, '_');
    relLines.push(`${files.get(e.source)},${files.get(e.target)},${edgeType},${e.confidence}`);
  }

  return { nodes: nodeLines.join('\n'), relationships: relLines.join('\n') };
}

/**
 * Render function-level graph data as Neo4j bulk-import CSV.
 *
 * @param {{ edges: Array }} data
 * @returns {{ nodes: string, relationships: string }}
 */
export function renderFunctionLevelNeo4jCSV(data) {
  const emitted = new Set();
  const nodeLines = ['nodeId:ID,name,kind,file:string,line:int,role,:LABEL'];
  function emitNode(id, name, kind, file, line, role) {
    if (emitted.has(id)) return;
    emitted.add(id);
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    nodeLines.push(
      `${id},${escapeCsv(name)},${escapeCsv(kind)},${escapeCsv(file)},${line},${escapeCsv(role || '')},${label}`,
    );
  }

  const relLines = [':START_ID,:END_ID,:TYPE,confidence:float'];
  for (const e of data.edges) {
    emitNode(
      e.source_id,
      e.source_name,
      e.source_kind,
      e.source_file,
      e.source_line,
      e.source_role,
    );
    emitNode(
      e.target_id,
      e.target_name,
      e.target_kind,
      e.target_file,
      e.target_line,
      e.target_role,
    );
    const edgeType = e.edge_kind.toUpperCase().replace(/-/g, '_');
    relLines.push(`${e.source_id},${e.target_id},${edgeType},${e.confidence}`);
  }

  return { nodes: nodeLines.join('\n'), relationships: relLines.join('\n') };
}
