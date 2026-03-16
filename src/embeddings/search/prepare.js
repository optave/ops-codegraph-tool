import { getEmbeddingCount, getEmbeddingMeta } from '../../db/repository/embeddings.js';
import { openReadonlyOrFail } from '../../db.js';
import { MODELS } from '../models.js';
import { applyFilters } from './filters.js';

/**
 * Shared setup for search functions: opens DB, validates embeddings/model, loads rows.
 * Returns { db, rows, modelKey, storedDim } or null on failure (prints error).
 * On null return, the DB is closed. On exception, the DB is also closed
 * (callers only need to close DB from the returned object on the happy path).
 */
export function prepareSearch(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);

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

    // Pre-filter: allow filtering by kind or file pattern to reduce search space
    const isGlob = opts.filePattern && /[*?[\]]/.test(opts.filePattern);
    let sql = `
    SELECT e.node_id, e.vector, e.text_preview, n.name, n.kind, n.file, n.line, n.end_line, n.role
    FROM embeddings e
    JOIN nodes n ON e.node_id = n.id
  `;
    const params = [];
    const conditions = [];
    if (opts.kind) {
      conditions.push('n.kind = ?');
      params.push(opts.kind);
    }
    if (opts.filePattern && !isGlob) {
      conditions.push('n.file LIKE ?');
      params.push(`%${opts.filePattern}%`);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    let rows = db.prepare(sql).all(...params);
    rows = applyFilters(rows, { ...opts, isGlob });

    return { db, rows, modelKey, storedDim };
  } catch (err) {
    db.close();
    throw err;
  }
}
