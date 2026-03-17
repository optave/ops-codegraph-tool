import { isTestFile } from '../../infrastructure/test-filter.js';

/**
 * Look up node(s) by name with optional file/kind/noTests filtering.
 *
 * @param {object} db - open SQLite database handle
 * @param {string} name - symbol name (partial LIKE match)
 * @param {object} [opts] - { kind, file, noTests }
 * @param {string[]} defaultKinds - fallback kinds when opts.kind is not set
 * @returns {object[]} matching node rows
 */
export function findNodes(db, name, opts = {}, defaultKinds = []) {
  const kinds = opts.kind ? [opts.kind] : defaultKinds;
  if (kinds.length === 0) throw new Error('findNodes: no kinds specified');
  const placeholders = kinds.map(() => '?').join(', ');
  const params = [`%${name}%`, ...kinds];

  let fileCondition = '';
  if (opts.file) {
    fileCondition = ' AND file LIKE ?';
    params.push(`%${opts.file}%`);
  }

  const rows = db
    .prepare(
      `SELECT * FROM nodes
       WHERE name LIKE ? AND kind IN (${placeholders})${fileCondition}
       ORDER BY file, line`,
    )
    .all(...params);

  return opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;
}
