import { iterateFunctionNodes, openReadonlyOrFail } from '../db/index.js';
import { buildFileConditionSQL } from '../db/query-builder.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import type { BetterSqlite3Database, NodeRow } from '../types.js';
import { ALL_SYMBOL_KINDS } from './kinds.js';

interface ListFunctionResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number | null;
  role: string | null;
}

interface IterListOpts {
  noTests?: boolean;
  file?: string;
  pattern?: string;
}

/**
 * Generator: stream functions one-by-one using .iterate() for memory efficiency.
 */
export function* iterListFunctions(
  customDbPath?: string,
  opts: IterListOpts = {},
): Generator<ListFunctionResult> {
  const db = openReadonlyOrFail(customDbPath) as BetterSqlite3Database;
  try {
    const noTests = opts.noTests || false;

    for (const row of iterateFunctionNodes(db, {
      file: opts.file,
      pattern: opts.pattern,
    }) as IterableIterator<NodeRow>) {
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

interface RoleResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number | null;
  role: string | null;
}

interface IterRolesOpts {
  noTests?: boolean;
  role?: string;
  file?: string;
}

/**
 * Generator: stream role-classified symbols one-by-one.
 */
export function* iterRoles(customDbPath?: string, opts: IterRolesOpts = {}): Generator<RoleResult> {
  const db = openReadonlyOrFail(customDbPath) as BetterSqlite3Database;
  try {
    const noTests = opts.noTests || false;
    const conditions = ['role IS NOT NULL'];
    const params: unknown[] = [];

    if (opts.role) {
      conditions.push('role = ?');
      params.push(opts.role);
    }
    {
      const fc = buildFileConditionSQL(opts.file ?? '', 'file');
      if (fc.sql) {
        conditions.push(fc.sql.replace(/^ AND /, ''));
        params.push(...fc.params);
      }
    }

    const stmt = db.prepare(
      `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY role, file, line`,
    );
    for (const row of stmt.iterate(...params) as IterableIterator<NodeRow>) {
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

interface WhereUse {
  name: string;
  file: string;
  line: number;
}

interface WhereResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  role: string | null;
  exported: boolean;
  uses: WhereUse[];
}

interface IterWhereOpts {
  noTests?: boolean;
}

/**
 * Generator: stream symbol lookup results one-by-one.
 */
export function* iterWhere(
  target: string,
  customDbPath?: string,
  opts: IterWhereOpts = {},
): Generator<WhereResult> {
  const db = openReadonlyOrFail(customDbPath) as BetterSqlite3Database;
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
    for (const node of stmt.iterate(
      `%${target}%`,
      ...ALL_SYMBOL_KINDS,
    ) as IterableIterator<NodeRow>) {
      if (noTests && isTestFile(node.file)) continue;

      const crossFileCallers = crossFileCallersStmt.get(node.id, node.file) as { cnt: number };
      const exported = crossFileCallers.cnt > 0;

      let uses = usesStmt.all(node.id) as WhereUse[];
      if (noTests) uses = uses.filter((u) => !isTestFile(u.file));

      yield {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        role: (node.role as string) || null,
        exported,
        uses: uses.map((u) => ({ name: u.name, file: u.file, line: u.line })),
      };
    }
  } finally {
    db.close();
  }
}
