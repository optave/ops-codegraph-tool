import { getClassHierarchy } from '../db/index.js';
import type { BetterSqlite3Database, NodeRow, Repository } from '../types.js';

/**
 * Resolve all methods in the class hierarchy that share the given method name.
 *
 * Accepts either a raw BetterSqlite3Database handle (legacy) or a Repository
 * instance (preferred — works with both SqliteRepository and NativeRepository).
 */
export function resolveMethodViaHierarchy(
  dbOrRepo: BetterSqlite3Database | Repository,
  methodName: string,
): NodeRow[] {
  // Detect Repository vs raw DB by duck-typing on findNodesWithFanIn
  if (
    typeof (dbOrRepo as Repository).findNodesWithFanIn === 'function' &&
    typeof (dbOrRepo as Repository).getClassHierarchy === 'function'
  ) {
    return resolveViaRepo(dbOrRepo as Repository, methodName);
  }
  return resolveViaRawDb(dbOrRepo as BetterSqlite3Database, methodName);
}

/** Strip fan_in from NodeRowWithFanIn to produce a plain NodeRow. */
function stripFanIn(rows: Array<{ fan_in: number } & NodeRow>): NodeRow[] {
  return rows.map(({ fan_in: _, ...rest }) => rest);
}

function resolveViaRepo(repo: Repository, methodName: string): NodeRow[] {
  const methods = stripFanIn(repo.findNodesWithFanIn(`%.${methodName}`, { kinds: ['method'] }));

  const results: NodeRow[] = [...methods];
  for (const m of methods) {
    const className = m.name.split('.')[0]!;
    const classNodes = repo.findNodesWithFanIn(className, {
      kinds: ['class'],
      file: m.file,
    });
    const classNode = classNodes[0];
    if (!classNode) continue;

    const ancestors = repo.getClassHierarchy(classNode.id);
    for (const ancestorId of ancestors) {
      const ancestor = repo.findNodeById(ancestorId);
      if (!ancestor) continue;
      const parentMethods = stripFanIn(
        repo.findNodesWithFanIn(`${ancestor.name}.${methodName}`, { kinds: ['method'] }),
      );
      results.push(...parentMethods);
    }
  }
  return results;
}

function resolveViaRawDb(db: BetterSqlite3Database, methodName: string): NodeRow[] {
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
