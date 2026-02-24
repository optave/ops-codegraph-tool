import path from 'node:path';
import { isTestFile } from './queries.js';

/**
 * Export the dependency graph in DOT (Graphviz) format.
 */
export function exportDOT(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
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
    `)
      .all();
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
    `)
      .all();
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

/**
 * Export the dependency graph in Mermaid format.
 */
export function exportMermaid(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;
  const lines = ['graph LR'];

  if (fileLevel) {
    let edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type', 'calls')
    `)
      .all();
    if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));

    for (const { source, target } of edges) {
      const s = source.replace(/[^a-zA-Z0-9]/g, '_');
      const t = target.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  ${s}["${source}"] --> ${t}["${target}"]`);
    }
  } else {
    let edges = db
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
    if (noTests)
      edges = edges.filter((e) => !isTestFile(e.source_file) && !isTestFile(e.target_file));

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
export function exportJSON(db, opts = {}) {
  const noTests = opts.noTests || false;

  let nodes = db
    .prepare(`
    SELECT id, name, kind, file, line FROM nodes WHERE kind = 'file'
  `)
    .all();
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  let edges = db
    .prepare(`
    SELECT DISTINCT n1.file AS source, n2.file AS target, e.kind
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE n1.file != n2.file
  `)
    .all();
  if (noTests) edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));

  return { nodes, edges };
}
