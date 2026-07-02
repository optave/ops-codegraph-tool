import { openReadonlyOrFail } from '../../../db/index.js';
import { buildFileConditionSQL } from '../../../db/query-builder.js';
import { getEmbeddingCount, getEmbeddingMeta } from '../../../db/repository/embeddings.js';
import { info } from '../../../infrastructure/logger.js';
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
  /** Raw model identifier recorded at embed time — set even when it isn't a
   * local registry key (e.g. a remote provider's model name). */
  storedModel: string | null;
  /**
   * Embedding backend recorded at embed time (e.g. `"openai"`), or `null` for
   * the local bundled model. Search-time routing must key off this rather
   * than the live config — the config may have changed since `embed` ran.
   */
  storedProvider: string | null;
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
      info('No embeddings found. Run `codegraph embed` first.');
      db.close();
      return null;
    }

    const storedModel = getEmbeddingMeta(db, 'model') || null;
    const storedProvider = getEmbeddingMeta(db, 'provider') || null;
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
      const fc = buildFileConditionSQL(fpArr, 'n.file');
      if (fc.sql) {
        // Strip leading ' AND ' since we're using conditions array
        conditions.push(fc.sql.replace(/^ AND /, ''));
        params.push(...fc.params);
      }
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    let rows = db.prepare(sql).all(...params) as PreparedSearch['rows'];
    rows = applyFilters(rows, opts);

    return { db, rows, modelKey, storedDim, storedModel, storedProvider };
  } catch (err) {
    db.close();
    throw err;
  }
}
