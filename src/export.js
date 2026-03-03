import path from 'node:path';
import { paginateResult } from './paginate.js';
import { isTestFile } from './queries.js';

const DEFAULT_MIN_CONFIDENCE = 0.5;

/** Escape special XML characters. */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC 4180 CSV field escaping — quote fields containing commas, quotes, or newlines. */
function escapeCsv(s) {
  const str = String(s);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Export the dependency graph in DOT (Graphviz) format.
 */
export function exportDOT(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const edgeLimit = opts.limit;
  const lines = [
    'digraph codegraph {',
    '  rankdir=LR;',
    '  node [shape=box, fontname="monospace", fontsize=10];',
    '  edge [color="#666666"];',
    '',
  ];

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
    const totalFileEdges = edges.length;
    if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

    // Try to use directory nodes from DB (built by structure analysis)
    const hasDirectoryNodes =
      db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get().c > 0;

    const dirs = new Map();
    const allFiles = new Set();
    for (const { source, target } of edges) {
      allFiles.add(source);
      allFiles.add(target);
    }

    if (hasDirectoryNodes) {
      // Use DB directory structure with cohesion labels
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
          dirs.set(d.name, { files: containedFiles, cohesion: d.cohesion });
        }
      }
    } else {
      // Fallback: reconstruct from path.dirname()
      for (const file of allFiles) {
        const dir = path.dirname(file) || '.';
        if (!dirs.has(dir)) dirs.set(dir, { files: [], cohesion: null });
        dirs.get(dir).files.push(file);
      }
    }

    let clusterIdx = 0;
    for (const [dir, info] of [...dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  subgraph cluster_${clusterIdx++} {`);
      const cohLabel = info.cohesion !== null ? ` (cohesion: ${info.cohesion.toFixed(2)})` : '';
      lines.push(`    label="${dir}${cohLabel}";`);
      lines.push(`    style=dashed;`);
      lines.push(`    color="#999999";`);
      for (const f of info.files) {
        const label = path.basename(f);
        lines.push(`    "${f}" [label="${label}"];`);
      }
      lines.push(`  }`);
      lines.push('');
    }

    for (const { source, target } of edges) {
      lines.push(`  "${source}" -> "${target}";`);
    }
    if (edgeLimit && totalFileEdges > edgeLimit) {
      lines.push(`  // Truncated: showing ${edges.length} of ${totalFileEdges} edges`);
    }
  } else {
    let edges = db
      .prepare(`
      SELECT n1.name AS source_name, n1.kind AS source_kind, n1.file AS source_file,
             n2.name AS target_name, n2.kind AS target_kind, n2.file AS target_file,
             e.kind AS edge_kind
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module') AND n2.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')
      AND e.kind = 'calls'
      AND e.confidence >= ?
    `)
      .all(minConf);
    if (noTests)
      edges = edges.filter((e) => !isTestFile(e.source_file) && !isTestFile(e.target_file));
    const totalFnEdges = edges.length;
    if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

    for (const e of edges) {
      const sId = `${e.source_file}:${e.source_name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const tId = `${e.target_file}:${e.target_name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${sId} [label="${e.source_name}\\n${path.basename(e.source_file)}"];`);
      lines.push(`  ${tId} [label="${e.target_name}\\n${path.basename(e.target_file)}"];`);
      lines.push(`  ${sId} -> ${tId};`);
    }
    if (edgeLimit && totalFnEdges > edgeLimit) {
      lines.push(`  // Truncated: showing ${edges.length} of ${totalFnEdges} edges`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

/** Escape double quotes for Mermaid labels. */
function escapeLabel(label) {
  return label.replace(/"/g, '#quot;');
}

/** Map node kind to Mermaid shape wrapper. */
function mermaidShape(kind, label) {
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
const ROLE_STYLES = {
  entry: 'fill:#e8f5e9,stroke:#4caf50',
  core: 'fill:#e3f2fd,stroke:#2196f3',
  utility: 'fill:#f5f5f5,stroke:#9e9e9e',
  dead: 'fill:#ffebee,stroke:#f44336',
  leaf: 'fill:#fffde7,stroke:#fdd835',
};

/**
 * Export the dependency graph in Mermaid format.
 */
export function exportMermaid(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const direction = opts.direction || 'LR';
  const edgeLimit = opts.limit;
  const lines = [`flowchart ${direction}`];

  let nodeCounter = 0;
  const nodeIdMap = new Map();
  function nodeId(key) {
    if (!nodeIdMap.has(key)) nodeIdMap.set(key, `n${nodeCounter++}`);
    return nodeIdMap.get(key);
  }

  if (fileLevel) {
    let edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target, e.kind AS edge_kind
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
        AND e.confidence >= ?
    `)
      .all(minConf);
    if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));
    const totalMermaidFileEdges = edges.length;
    if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

    // Collect all files referenced in edges
    const allFiles = new Set();
    for (const { source, target } of edges) {
      allFiles.add(source);
      allFiles.add(target);
    }

    // Build directory groupings — try DB directory nodes first, fall back to path.dirname()
    const dirs = new Map();
    const hasDirectoryNodes =
      db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get().c > 0;

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

    // Emit subgraphs
    for (const [dir, files] of [...dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sgId = dir.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  subgraph ${sgId}["${escapeLabel(dir)}"]`);
      for (const f of files) {
        const nId = nodeId(f);
        lines.push(`    ${nId}["${escapeLabel(path.basename(f))}"]`);
      }
      lines.push('  end');
    }

    // Deduplicate edges per source-target pair, collecting all distinct kinds
    const edgeMap = new Map();
    for (const { source, target, edge_kind } of edges) {
      const key = `${source}|${target}`;
      const label = edge_kind === 'imports-type' ? 'imports' : edge_kind;
      if (!edgeMap.has(key)) edgeMap.set(key, { source, target, labels: new Set() });
      edgeMap.get(key).labels.add(label);
    }

    for (const { source, target, labels } of edgeMap.values()) {
      lines.push(`  ${nodeId(source)} -->|${[...labels].join(', ')}| ${nodeId(target)}`);
    }
    if (edgeLimit && totalMermaidFileEdges > edgeLimit) {
      lines.push(`  %% Truncated: showing ${edges.length} of ${totalMermaidFileEdges} edges`);
    }
  } else {
    let edges = db
      .prepare(`
      SELECT n1.name AS source_name, n1.kind AS source_kind, n1.file AS source_file,
             n2.name AS target_name, n2.kind AS target_kind, n2.file AS target_file,
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
    const totalMermaidFnEdges = edges.length;
    if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

    // Group nodes by file for subgraphs
    const fileNodes = new Map();
    const nodeKinds = new Map();
    for (const e of edges) {
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
    for (const e of edges) {
      const sId = nodeId(`${e.source_file}::${e.source_name}`);
      const tId = nodeId(`${e.target_file}::${e.target_name}`);
      lines.push(`  ${sId} -->|${e.edge_kind}| ${tId}`);
    }
    if (edgeLimit && totalMermaidFnEdges > edgeLimit) {
      lines.push(`  %% Truncated: showing ${edges.length} of ${totalMermaidFnEdges} edges`);
    }

    // Role styling — query roles for all referenced nodes
    const allKeys = [...nodeIdMap.keys()];
    const roleStyles = [];
    for (const key of allKeys) {
      const colonIdx = key.indexOf('::');
      if (colonIdx === -1) continue;
      const file = key.slice(0, colonIdx);
      const name = key.slice(colonIdx + 2);
      const row = db
        .prepare('SELECT role FROM nodes WHERE file = ? AND name = ? AND role IS NOT NULL LIMIT 1')
        .get(file, name);
      if (row?.role && ROLE_STYLES[row.role]) {
        roleStyles.push(`  style ${nodeIdMap.get(key)} ${ROLE_STYLES[row.role]}`);
      }
    }
    lines.push(...roleStyles);
  }

  return lines.join('\n');
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
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const edgeLimit = opts.limit;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphstruct.net/graphml">',
  ];

  if (fileLevel) {
    lines.push('  <key id="d0" for="node" attr.name="name" attr.type="string"/>');
    lines.push('  <key id="d1" for="node" attr.name="file" attr.type="string"/>');
    lines.push('  <key id="d2" for="edge" attr.name="kind" attr.type="string"/>');
    lines.push('  <graph id="codegraph" edgedefault="directed">');

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
    if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

    const files = new Set();
    for (const { source, target } of edges) {
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
    for (const { source, target } of edges) {
      lines.push(
        `    <edge id="e${eIdx++}" source="${fileIds.get(source)}" target="${fileIds.get(target)}">`,
      );
      lines.push('      <data key="d2">imports</data>');
      lines.push('    </edge>');
    }
  } else {
    lines.push('  <key id="d0" for="node" attr.name="name" attr.type="string"/>');
    lines.push('  <key id="d1" for="node" attr.name="kind" attr.type="string"/>');
    lines.push('  <key id="d2" for="node" attr.name="file" attr.type="string"/>');
    lines.push('  <key id="d3" for="node" attr.name="line" attr.type="int"/>');
    lines.push('  <key id="d4" for="node" attr.name="role" attr.type="string"/>');
    lines.push('  <key id="d5" for="edge" attr.name="kind" attr.type="string"/>');
    lines.push('  <key id="d6" for="edge" attr.name="confidence" attr.type="double"/>');
    lines.push('  <graph id="codegraph" edgedefault="directed">');

    let edges = db
      .prepare(`
      SELECT n1.id AS source_id, n1.name AS source_name, n1.kind AS source_kind,
             n1.file AS source_file, n1.line AS source_line, n1.role AS source_role,
             n2.id AS target_id, n2.name AS target_name, n2.kind AS target_kind,
             n2.file AS target_file, n2.line AS target_line, n2.role AS target_role,
             e.kind AS edge_kind, e.confidence
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
    if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

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
    for (const e of edges) {
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
  }

  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n');
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
    WHERE kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'file')
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
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const edgeLimit = opts.limit;

  if (fileLevel) {
    let edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target, e.kind, e.confidence
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
        AND e.confidence >= ?
    `)
      .all(minConf);
    if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));
    if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

    const files = new Map();
    let idx = 0;
    for (const { source, target } of edges) {
      if (!files.has(source)) files.set(source, idx++);
      if (!files.has(target)) files.set(target, idx++);
    }

    const nodeLines = ['nodeId:ID,name,file:string,:LABEL'];
    for (const [file, id] of files) {
      nodeLines.push(`${id},${escapeCsv(path.basename(file))},${escapeCsv(file)},File`);
    }

    const relLines = [':START_ID,:END_ID,:TYPE,confidence:float'];
    for (const e of edges) {
      const edgeType = e.kind.toUpperCase().replace(/-/g, '_');
      relLines.push(`${files.get(e.source)},${files.get(e.target)},${edgeType},${e.confidence}`);
    }

    return { nodes: nodeLines.join('\n'), relationships: relLines.join('\n') };
  }

  let edges = db
    .prepare(`
    SELECT n1.id AS source_id, n1.name AS source_name, n1.kind AS source_kind,
           n1.file AS source_file, n1.line AS source_line, n1.role AS source_role,
           n2.id AS target_id, n2.name AS target_name, n2.kind AS target_kind,
           n2.file AS target_file, n2.line AS target_line, n2.role AS target_role,
           e.kind AS edge_kind, e.confidence
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
  if (edgeLimit && edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

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
  for (const e of edges) {
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
