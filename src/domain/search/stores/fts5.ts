import type { BetterSqlite3Database } from '../../../types.js';

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 */
export function sanitizeFtsQuery(query: string): string | null {
  const cleaned = query.replace(/[*"():^{}~<>]/g, ' ').trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return `"${tokens[0]}"`;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Check if the FTS5 index exists in the database.
 */
export function hasFtsIndex(db: BetterSqlite3Database): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM fts_index').get() as
      | { c: number }
      | undefined;
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}
