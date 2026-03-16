/**
 * Build a containment graph (directory → file) from the SQLite database.
 */

import { CodeGraph } from '../model.js';

/**
 * @param {object} db - Open better-sqlite3 database (readonly)
 * @returns {CodeGraph} Directed graph with directory→file containment edges
 */
export function buildStructureGraph(db) {
  const graph = new CodeGraph();

  const dirs = db.prepare("SELECT id, name FROM nodes WHERE kind = 'directory'").all();

  for (const d of dirs) {
    graph.addNode(String(d.id), { label: d.name, kind: 'directory' });
  }

  const files = db.prepare("SELECT id, name, file FROM nodes WHERE kind = 'file'").all();

  for (const f of files) {
    graph.addNode(String(f.id), { label: f.name, kind: 'file', file: f.file });
  }

  const containsEdges = db
    .prepare(`
      SELECT e.source_id, e.target_id
      FROM edges e
      JOIN nodes n ON e.source_id = n.id
      WHERE e.kind = 'contains' AND n.kind = 'directory'
    `)
    .all();

  for (const e of containsEdges) {
    graph.addEdge(String(e.source_id), String(e.target_id), { kind: 'contains' });
  }

  return graph;
}
