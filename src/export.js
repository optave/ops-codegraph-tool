import path from 'node:path';

/**
 * Export the dependency graph in DOT (Graphviz) format.
 */
export function exportDOT(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const lines = [
    'digraph codegraph {',
    '  rankdir=LR;',
    '  node [shape=box, fontname="monospace", fontsize=10];',
    '  edge [color="#666666"];',
    '',
  ];

  if (fileLevel) {
    const edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
    `)
      .all();

    const dirs = new Map();
    const allFiles = new Set();
    for (const { source, target } of edges) {
      allFiles.add(source);
      allFiles.add(target);
    }
    for (const file of allFiles) {
      const dir = path.dirname(file) || '.';
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(file);
    }

    let clusterIdx = 0;
    for (const [dir, files] of [...dirs].sort()) {
      lines.push(`  subgraph cluster_${clusterIdx++} {`);
      lines.push(`    label="${dir}";`);
      lines.push(`    style=dashed;`);
      lines.push(`    color="#999999";`);
      for (const f of files) {
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
    const edges = db
      .prepare(`
      SELECT n1.name AS source_name, n1.kind AS source_kind, n1.file AS source_file,
             n2.name AS target_name, n2.kind AS target_kind, n2.file AS target_file,
             e.kind AS edge_kind
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module') AND n2.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')
      AND e.kind = 'calls'
    `)
      .all();

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

/**
 * Export the dependency graph in Mermaid format.
 */
export function exportMermaid(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const lines = ['graph LR'];

  if (fileLevel) {
    const edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
    `)
      .all();

    for (const { source, target } of edges) {
      const s = source.replace(/[^a-zA-Z0-9]/g, '_');
      const t = target.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  ${s}["${source}"] --> ${t}["${target}"]`);
    }
  } else {
    const edges = db
      .prepare(`
      SELECT n1.name AS source_name, n1.file AS source_file,
             n2.name AS target_name, n2.file AS target_file
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module') AND n2.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')
      AND e.kind = 'calls'
    `)
      .all();

    for (const e of edges) {
      const sId = `${e.source_file}_${e.source_name}`.replace(/[^a-zA-Z0-9]/g, '_');
      const tId = `${e.target_file}_${e.target_name}`.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  ${sId}["${e.source_name}"] --> ${tId}["${e.target_name}"]`);
    }
  }

  return lines.join('\n');
}

/**
 * Export as JSON adjacency list.
 */
export function exportJSON(db) {
  const nodes = db
    .prepare(`
    SELECT id, name, kind, file, line FROM nodes WHERE kind = 'file'
  `)
    .all();

  const edges = db
    .prepare(`
    SELECT DISTINCT n1.file AS source, n2.file AS target, e.kind
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE n1.file != n2.file
  `)
    .all();

  return { nodes, edges };
}
