import { openReadonlyOrFail } from '../../db/index.js';
import { buildFileConditionSQL } from '../../db/query-builder.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { DEAD_ROLE_PREFIX } from '../../shared/kinds.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';

export function rolesData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const filterRole = opts.role || null;
    const conditions = ['role IS NOT NULL'];
    const params = [];

    if (filterRole) {
      if (filterRole === DEAD_ROLE_PREFIX) {
        conditions.push(`role LIKE '${DEAD_ROLE_PREFIX}%'`);
      } else {
        conditions.push('role = ?');
        params.push(filterRole);
      }
    }
    {
      const fc = buildFileConditionSQL(opts.file, 'file');
      if (fc.sql) {
        // Strip leading ' AND ' since we're using conditions array
        conditions.push(fc.sql.replace(/^ AND /, ''));
        params.push(...fc.params);
      }
    }

    let rows = db
      .prepare(
        `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY role, file, line`,
      )
      .all(...params);

    if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

    const summary = {};
    for (const r of rows) {
      summary[r.role] = (summary[r.role] || 0) + 1;
    }

    const hc = new Map();
    const symbols = rows.map((r) => normalizeSymbol(r, db, hc));
    const base = { count: symbols.length, summary, symbols };
    return paginateResult(base, 'symbols', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
