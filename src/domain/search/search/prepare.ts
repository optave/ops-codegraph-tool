import { openReadonlyOrFail } from '../../../db/index.js';
import { escapeLike } from '../../../db/query-builder.js';
import { getEmbeddingCount, getEmbeddingMeta } from '../../../db/repository/embeddings.js';
import type { BetterSqlite3Database } from '../../../types.js';
import { MODELS } from '../models.js';
import { applyFilters } from './filters.js';

export interface PreparedSearch {
  db: BetterSqlite3Database;
  rows: Array<{
    node_id: number;
    vector: Buffer;
    text_preview: string;
    name: string;
    kind: string;
    file: string;
    line: number;
    end_line: number | null;
    role: string | null;
  }>;
  modelKey: string | null;
  storedDim: number | null;
}

export interface PrepareSearchOpts {
  model?: string;
  kind?: string;
  filePattern?: string | string[];
  noTests?: boolean;
}

export function prepareSearch(
  customDbPath: string | undefined,
  opts: PrepareSearchOpts = {},
): PreparedSearch | null {
  const db = openReadonlyOrFail(customDbPath) as BetterSqlite3Database;

  try {
    const count = getEmbeddingCount(db);
    if (count === 0) {
      console.log('No embeddings found. Run `codegraph embed` first.');
      db.close();
      return null;
    }

    const storedModel = getEmbeddingMeta(db, 'model') || null;
    const dimStr = getEmbeddingMeta(db, 'dim');
    const storedDim = dimStr ? parseInt(dimStr, 10) : null;

    let modelKey = opts.model || null;
    if (!modelKey && storedModel) {
      for (const [key, config] of Object.entries(MODELS)) {
        if (config.name === storedModel) {
          modelKey = key;
          break;
        }
      }
    }

    const fp = opts.filePattern;
    const fpArr = Array.isArray(fp) ? fp : fp ? [fp] : [];
    const isGlob = fpArr.length > 0 && fpArr.some((p) => /[*?[\]]/.test(p));
    let sql = `
    SELECT e.node_id, e.vector, e.text_preview, n.name, n.kind, n.file, n.line, n.end_line, n.role
    FROM embeddings e
    JOIN nodes n ON e.node_id = n.id
  `;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (opts.kind) {
      conditions.push('n.kind = ?');
      params.push(opts.kind);
    }
    if (fpArr.length > 0 && !isGlob) {
      if (fpArr.length === 1) {
        conditions.push("n.file LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(fpArr[0]!)}%`);
      } else {
        conditions.push(`(${fpArr.map(() => "n.file LIKE ? ESCAPE '\\'").join(' OR ')})`);
        params.push(...fpArr.map((f) => `%${escapeLike(f)}%`));
      }
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    let rows = db.prepare(sql).all(...params) as PreparedSearch['rows'];
    rows = applyFilters(rows, opts);

    return { db, rows, modelKey, storedDim };
  } catch (err) {
    db.close();
    throw err;
  }
}
