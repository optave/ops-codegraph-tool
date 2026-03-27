import { openReadonlyOrFail } from '../../db/index.js';
import type { BetterSqlite3Database } from '../../types.js';

/**
 * Open the graph database in readonly mode with a clean close() handle.
 */
export function openGraph(opts: { db?: string } = {}): {
  db: BetterSqlite3Database;
  close: () => void;
} {
  const db = openReadonlyOrFail(opts.db);
  return { db, close: () => db.close() };
}
