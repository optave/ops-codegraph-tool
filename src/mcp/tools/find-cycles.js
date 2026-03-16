import { findDbPath } from '../../db/index.js';
import { findCycles } from '../../domain/graph/cycles.js';

export const name = 'find_cycles';

export async function handler(_args, ctx) {
  const Database = ctx.getDatabase();
  const db = new Database(findDbPath(ctx.dbPath), { readonly: true });
  try {
    const cycles = findCycles(db);
    return { cycles, count: cycles.length };
  } finally {
    db.close();
  }
}
