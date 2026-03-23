/**
 * Build a co-change (temporal) graph weighted by Jaccard similarity.
 */

import type { BetterSqlite3Database } from '../../types.js';
import { CodeGraph } from '../model.js';

export interface TemporalGraphOptions {
  minJaccard?: number;
}

interface TableCheckRow {
  name: string;
}

interface CoChangeRow {
  file_a: string;
  file_b: string;
  jaccard: number;
}

/**
 * Build an undirected graph weighted by Jaccard similarity from the co_changes table.
 */
export function buildTemporalGraph(
  db: BetterSqlite3Database,
  opts: TemporalGraphOptions = {},
): CodeGraph {
  const minJaccard = opts.minJaccard ?? 0.0;
  const graph = new CodeGraph({ directed: false });

  // Check if co_changes table exists
  const tableCheck = db
    .prepare<TableCheckRow>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='co_changes'",
    )
    .get();
  if (!tableCheck) return graph;

  const rows = db
    .prepare<CoChangeRow>('SELECT file_a, file_b, jaccard FROM co_changes WHERE jaccard >= ?')
    .all(minJaccard);

  for (const r of rows) {
    if (!graph.hasNode(r.file_a)) graph.addNode(r.file_a, { label: r.file_a });
    if (!graph.hasNode(r.file_b)) graph.addNode(r.file_b, { label: r.file_b });
    graph.addEdge(r.file_a, r.file_b, { jaccard: r.jaccard });
  }

  return graph;
}
