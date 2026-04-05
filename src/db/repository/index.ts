// Barrel re-export for repository/ modules.

export type { FnDepsCallerNode, FnDepsEntry, FnDepsNode, FnDepsResult } from './base.js';
export { Repository } from './base.js';
export { purgeFileData, purgeFilesData } from './build-stmts.js';
export { cachedStmt } from './cached-stmt.js';
export { deleteCfgForNode, getCfgBlocks, getCfgEdges, hasCfgTables } from './cfg.js';
export { getCoChangeMeta, hasCoChanges, upsertCoChangeMeta } from './cochange.js';
export { getComplexityForNode } from './complexity.js';
export { hasDataflowTable } from './dataflow.js';
export {
  countCrossFileCallers,
  findAllIncomingEdges,
  findAllOutgoingEdges,
  findCalleeNames,
  findCallees,
  findCallerNames,
  findCallers,
  findCrossFileCallTargets,
  findDistinctCallers,
  findImplementors,
  findImportDependents,
  findImportSources,
  findImportTargets,
  findInterfaces,
  findIntraFileCallEdges,
  getClassHierarchy,
} from './edges.js';
export { getEmbeddingCount, getEmbeddingMeta, hasEmbeddings } from './embeddings.js';
export { getCallableNodes, getCallEdges, getFileNodesAll, getImportEdges } from './graph-read.js';
export { InMemoryRepository } from './in-memory-repository.js';
export { NativeRepository } from './native-repository.js';
export {
  bulkNodeIdsByFile,
  countEdges,
  countFiles,
  countNodes,
  findFileNodes,
  findNodeById,
  findNodeByQualifiedName,
  findNodeChildren,
  findNodesByFile,
  findNodesByScope,
  findNodesForTriage,
  findNodesWithFanIn,
  getFunctionNodeId,
  getLineCountForNode,
  getMaxEndLineForFile,
  getNodeId,
  iterateFunctionNodes,
  listFunctionNodes,
} from './nodes.js';
export { SqliteRepository } from './sqlite-repository.js';
