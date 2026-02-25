import path from 'node:path';
import { isTestFile } from './queries.js';

const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Export the dependency graph in DOT (Graphviz) format.
 */
export function exportDOT(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
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

    for (const e of edges) {
      const sId = `${e.source_file}:${e.source_name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const tId = `${e.target_file}:${e.target_name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${sId} [label="${e.source_name}\\n${path.basename(e.source_file)}"];`);
      lines.push(`  ${tId} [label="${e.target_name}\\n${path.basename(e.target_file)}"];`);
      lines.push(`  ${sId} -> ${tId};`);
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

  return { nodes, edges };
}
