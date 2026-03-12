import { findCycles } from '../../cycles.js';
import { findDbPath } from '../../db.js';

export const name = 'find_cycles';

export async function handler(_args, ctx) {
  const Database = ctx.getDatabase();
  const db = new Database(findDbPath(ctx.dbPath), { readonly: true });
  const cycles = findCycles(db);
  db.close();
  return { cycles, count: cycles.length };
}
