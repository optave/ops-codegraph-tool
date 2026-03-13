/**
 * Build a co-change (temporal) graph weighted by Jaccard similarity.
 */

import { CodeGraph } from '../model.js';

/**
 * @param {object} db - Open better-sqlite3 database (readonly)
 * @param {{ minJaccard?: number }} [opts]
 * @returns {CodeGraph} Undirected graph weighted by Jaccard similarity
 */
export function buildTemporalGraph(db, opts = {}) {
  const minJaccard = opts.minJaccard ?? 0.0;
  const graph = new CodeGraph({ directed: false });

  // Check if co_changes table exists
  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='co_changes'")
    .get();
  if (!tableCheck) return graph;

  const rows = db
    .prepare('SELECT file_a, file_b, jaccard FROM co_changes WHERE jaccard >= ?')
    .all(minJaccard);

  for (const r of rows) {
    if (!graph.hasNode(r.file_a)) graph.addNode(r.file_a, { label: r.file_a });
    if (!graph.hasNode(r.file_b)) graph.addNode(r.file_b, { label: r.file_b });
    graph.addEdge(r.file_a, r.file_b, { jaccard: r.jaccard });
  }

  return graph;
}
