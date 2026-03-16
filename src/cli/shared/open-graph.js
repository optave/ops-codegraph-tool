import { openReadonlyOrFail } from '../../db/index.js';

/**
 * Open the graph database in readonly mode with a clean close() handle.
 *
 * @param {object} [opts]
 * @param {string} [opts.db] - Custom path to graph.db
 * @returns {{ db: import('better-sqlite3').Database, close: () => void }}
 */
export function openGraph(opts = {}) {
  const db = openReadonlyOrFail(opts.db);
  return { db, close: () => db.close() };
}
