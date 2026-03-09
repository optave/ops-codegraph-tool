// Barrel re-export — keeps all existing `import { ... } from './db.js'` working.
export { closeDb, findDbPath, openDb, openReadonlyOrFail } from './db/connection.js';
export { getBuildMeta, initSchema, MIGRATIONS, setBuildMeta } from './db/migrations.js';
export {
  fanInJoinSQL,
  fanOutJoinSQL,
  kindInClause,
  NodeQuery,
  testFilterSQL,
} from './db/query-builder.js';
export {
  countEdges,
  countFiles,
  countNodes,
  findNodesForTriage,
  findNodesWithFanIn,
  iterateFunctionNodes,
  listFunctionNodes,
} from './db/repository.js';
