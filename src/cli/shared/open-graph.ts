import type Database from 'better-sqlite3';
import { openReadonlyOrFail } from '../../db/index.js';

/**
 * Open the graph database in readonly mode with a clean close() handle.
 */
export function openGraph(opts: { db?: string } = {}): {
  db: Database.Database;
  close: () => void;
} {
  const db = openReadonlyOrFail(opts.db);
  return { db, close: () => db.close() };
}
