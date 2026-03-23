import { getClassHierarchy } from '../db/index.js';
import type { BetterSqlite3Database, NodeRow } from '../types.js';

export function resolveMethodViaHierarchy(
  db: BetterSqlite3Database,
  methodName: string,
): NodeRow[] {
  const methods = db
    .prepare(`SELECT * FROM nodes WHERE kind = 'method' AND name LIKE ?`)
    .all(`%.${methodName}`) as NodeRow[];

  const results: NodeRow[] = [...methods];
  for (const m of methods) {
    const className = m.name.split('.')[0];
    const classNode = db
      .prepare(`SELECT * FROM nodes WHERE name = ? AND kind = 'class' AND file = ?`)
      .get(className, m.file) as NodeRow | undefined;
    if (!classNode) continue;

    const ancestors = getClassHierarchy(db, classNode.id);
    for (const ancestorId of ancestors) {
      const ancestor = db.prepare('SELECT name FROM nodes WHERE id = ?').get(ancestorId) as
        | { name: string }
        | undefined;
      if (!ancestor) continue;
      const parentMethods = db
        .prepare(`SELECT * FROM nodes WHERE name = ? AND kind = 'method'`)
        .all(`${ancestor.name}.${methodName}`) as NodeRow[];
      results.push(...parentMethods);
    }
  }
  return results;
}
