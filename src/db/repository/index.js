// Barrel re-export for repository/ modules.

export { purgeFileData, purgeFilesData } from './build-stmts.js';
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
  findImportDependents,
  findImportSources,
  findImportTargets,
  findIntraFileCallEdges,
  getClassHierarchy,
} from './edges.js';
export { getEmbeddingCount, getEmbeddingMeta, hasEmbeddings } from './embeddings.js';
export { getCallableNodes, getCallEdges, getFileNodesAll, getImportEdges } from './graph-read.js';
export {
  bulkNodeIdsByFile,
  countEdges,
  countFiles,
  countNodes,
  findFileNodes,
  findNodeById,
  findNodeChildren,
  findNodesByFile,
  findNodesForTriage,
  findNodesWithFanIn,
  getFunctionNodeId,
  getNodeId,
  iterateFunctionNodes,
  listFunctionNodes,
} from './nodes.js';
