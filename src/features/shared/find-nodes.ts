import { buildFileConditionSQL } from '../../db/query-builder.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import type { BetterSqlite3Database, NodeRow } from '../../types.js';

export function findNodes(
  db: BetterSqlite3Database,
  name: string,
  opts: { kind?: string; file?: string | string[]; noTests?: boolean } = {},
  defaultKinds: string[] = [],
): NodeRow[] {
  const kinds = opts.kind ? [opts.kind] : defaultKinds;
  if (kinds.length === 0) throw new Error('findNodes: no kinds specified');
  const placeholders = kinds.map(() => '?').join(', ');
  const params: unknown[] = [`%${name}%`, ...kinds];

  const fc = buildFileConditionSQL(opts.file ?? [], 'file');
  params.push(...fc.params);

  const rows = db
    .prepare(
      `SELECT * FROM nodes
       WHERE name LIKE ? AND kind IN (${placeholders})${fc.sql}
       ORDER BY file, line`,
    )
    .all(...params) as NodeRow[];

  return opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;
}
