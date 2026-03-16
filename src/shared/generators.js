import { iterateFunctionNodes, openReadonlyOrFail } from '../db.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { ALL_SYMBOL_KINDS } from '../kinds.js';

/**
 * Generator: stream functions one-by-one using .iterate() for memory efficiency.
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @param {string} [opts.file]
 * @param {string} [opts.pattern]
 * @yields {{ name: string, kind: string, file: string, line: number, role: string|null }}
 */
export function* iterListFunctions(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    for (const row of iterateFunctionNodes(db, { file: opts.file, pattern: opts.pattern })) {
      if (noTests && isTestFile(row.file)) continue;
      yield {
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        endLine: row.end_line ?? null,
        role: row.role ?? null,
      };
    }
  } finally {
    db.close();
  }
}

/**
 * Generator: stream role-classified symbols one-by-one.
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @param {string} [opts.role]
 * @param {string} [opts.file]
 * @yields {{ name: string, kind: string, file: string, line: number, endLine: number|null, role: string }}
 */
export function* iterRoles(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const conditions = ['role IS NOT NULL'];
    const params = [];

    if (opts.role) {
      conditions.push('role = ?');
      params.push(opts.role);
    }
    if (opts.file) {
      conditions.push('file LIKE ?');
      params.push(`%${opts.file}%`);
    }

    const stmt = db.prepare(
      `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY role, file, line`,
    );
    for (const row of stmt.iterate(...params)) {
      if (noTests && isTestFile(row.file)) continue;
      yield {
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        endLine: row.end_line ?? null,
        role: row.role ?? null,
      };
    }
  } finally {
    db.close();
  }
}

/**
 * Generator: stream symbol lookup results one-by-one.
 * @param {string} target - Symbol name to search for (partial match)
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @yields {{ name: string, kind: string, file: string, line: number, role: string|null, exported: boolean, uses: object[] }}
 */
export function* iterWhere(target, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const placeholders = ALL_SYMBOL_KINDS.map(() => '?').join(', ');
    const stmt = db.prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN (${placeholders}) ORDER BY file, line`,
    );
    const crossFileCallersStmt = db.prepare(
      `SELECT COUNT(*) as cnt FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'calls' AND n.file != ?`,
    );
    const usesStmt = db.prepare(
      `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'calls'`,
    );
    for (const node of stmt.iterate(`%${target}%`, ...ALL_SYMBOL_KINDS)) {
      if (noTests && isTestFile(node.file)) continue;

      const crossFileCallers = crossFileCallersStmt.get(node.id, node.file);
      const exported = crossFileCallers.cnt > 0;

      let uses = usesStmt.all(node.id);
      if (noTests) uses = uses.filter((u) => !isTestFile(u.file));

      yield {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        role: node.role || null,
        exported,
        uses: uses.map((u) => ({ name: u.name, file: u.file, line: u.line })),
      };
    }
  } finally {
    db.close();
  }
}
