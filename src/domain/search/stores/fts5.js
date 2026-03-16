/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Wraps each token as an implicit OR and escapes special FTS5 characters.
 */
export function sanitizeFtsQuery(query) {
  // Remove FTS5 special chars that could cause syntax errors
  const cleaned = query.replace(/[*"():^{}~<>]/g, ' ').trim();
  if (!cleaned) return null;
  // Split into tokens, wrap with OR for multi-token queries
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return `"${tokens[0]}"`;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Check if the FTS5 index exists in the database.
 * Returns true if fts_index table exists and has rows, false otherwise.
 */
export function hasFtsIndex(db) {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM fts_index').get();
    return row.c > 0;
  } catch {
    return false;
  }
}
