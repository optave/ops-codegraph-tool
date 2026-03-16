import { openReadonlyOrFail } from '../../../db/index.js';
import { normalizeSymbol } from '../../queries.js';
import { hasFtsIndex, sanitizeFtsQuery } from '../stores/fts5.js';
import { applyFilters } from './filters.js';

/**
 * BM25 keyword search via FTS5.
 * Returns { results: [{ name, kind, file, line, bm25Score }] } or null if no FTS5 index.
 */
export function ftsSearchData(query, customDbPath, opts = {}) {
  const limit = opts.limit || 15;

  const db = openReadonlyOrFail(customDbPath);

  try {
    if (!hasFtsIndex(db)) {
      return null;
    }

    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) {
      return { results: [] };
    }

    let sql = `
      SELECT f.rowid AS node_id, rank AS bm25_score,
             n.name, n.kind, n.file, n.line, n.end_line, n.role
      FROM fts_index f
      JOIN nodes n ON f.rowid = n.id
      WHERE fts_index MATCH ?
    `;
    const params = [ftsQuery];

    if (opts.kind) {
      sql += ' AND n.kind = ?';
      params.push(opts.kind);
    }

    const isGlob = opts.filePattern && /[*?[\]]/.test(opts.filePattern);
    if (opts.filePattern && !isGlob) {
      sql += ' AND n.file LIKE ?';
      params.push(`%${opts.filePattern}%`);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit * 5); // fetch generous set for post-filtering

    let rows;
    try {
      rows = db.prepare(sql).all(...params);
    } catch {
      // Invalid FTS5 query syntax — return empty
      return { results: [] };
    }

    rows = applyFilters(rows, { ...opts, isGlob });

    const hc = new Map();
    const results = rows.slice(0, limit).map((row) => ({
      ...normalizeSymbol(row, db, hc),
      bm25Score: -row.bm25_score, // FTS5 rank is negative; negate for display
    }));

    return { results };
  } finally {
    db.close();
  }
}
