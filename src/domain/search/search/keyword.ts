import { openReadonlyOrFail } from '../../../db/index.js';
import { buildFileConditionSQL } from '../../../db/query-builder.js';
import type { BetterSqlite3Database } from '../../../types.js';
import { normalizeSymbol } from '../../queries.js';
import { hasFtsIndex, sanitizeFtsQuery } from '../stores/fts5.js';
import { applyFilters } from './filters.js';

export interface FtsSearchOpts {
  limit?: number;
  kind?: string;
  filePattern?: string | string[];
  noTests?: boolean;
}

interface FtsRow {
  node_id: number;
  bm25_score: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number | null;
  role: string | null;
}

export interface FtsSearchResult {
  results: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    bm25Score: number;
    [key: string]: unknown;
  }>;
}

export function ftsSearchData(
  query: string,
  customDbPath: string | undefined,
  opts: FtsSearchOpts = {},
): FtsSearchResult | null {
  const limit = opts.limit || 15;

  const db = openReadonlyOrFail(customDbPath) as BetterSqlite3Database;

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
    const params: unknown[] = [ftsQuery];

    if (opts.kind) {
      sql += ' AND n.kind = ?';
      params.push(opts.kind);
    }

    const fp = opts.filePattern;
    const fpArr = Array.isArray(fp) ? fp : fp ? [fp] : [];
    const isGlob = fpArr.length > 0 && fpArr.some((p) => /[*?[\]]/.test(p));
    if (fpArr.length > 0 && !isGlob) {
      const fc = buildFileConditionSQL(fpArr, 'n.file');
      sql += fc.sql;
      params.push(...fc.params);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit * 5);

    let rows: FtsRow[];
    try {
      rows = db.prepare(sql).all(...params) as FtsRow[];
    } catch {
      return { results: [] };
    }

    rows = applyFilters(rows, opts);

    const hc = new Map<string, string>();
    const results = rows.slice(0, limit).map((row) => ({
      ...normalizeSymbol(row, db, hc),
      bm25Score: -row.bm25_score,
    }));

    return { results };
  } finally {
    db.close();
  }
}
