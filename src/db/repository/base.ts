import type {
  AdjacentEdgeRow,
  CallableNodeRow,
  CallEdgeRow,
  ChildNodeRow,
  ComplexityMetrics,
  FileNodeRow,
  ImportEdgeRow,
  ImportGraphEdgeRow,
  IntraFileCallEdge,
  Repository as IRepository,
  ListFunctionOpts,
  NodeIdRow,
  NodeRow,
  NodeRowWithFanIn,
  QueryOpts,
  RelatedNodeRow,
  TriageNodeRow,
  TriageQueryOpts,
} from '../../types.js';

/**
 * Abstract Repository base class.
 *
 * Defines the contract for all graph data access. Every method throws
 * "not implemented" by default — concrete subclasses override what they support.
 */
export class Repository implements IRepository {
  // ── Node lookups ────────────────────────────────────────────────────
  findNodeById(_id: number): NodeRow | undefined {
    throw new Error('not implemented');
  }

  findNodesByFile(_file: string): NodeRow[] {
    throw new Error('not implemented');
  }

  findFileNodes(_fileLike: string): NodeRow[] {
    throw new Error('not implemented');
  }

  findNodesWithFanIn(_namePattern: string, _opts?: QueryOpts): NodeRowWithFanIn[] {
    throw new Error('not implemented');
  }

  countNodes(): number {
    throw new Error('not implemented');
  }

  countEdges(): number {
    throw new Error('not implemented');
  }

  countFiles(): number {
    throw new Error('not implemented');
  }

  getNodeId(_name: string, _kind: string, _file: string, _line: number): number | undefined {
    throw new Error('not implemented');
  }

  getFunctionNodeId(_name: string, _file: string, _line: number): number | undefined {
    throw new Error('not implemented');
  }

  bulkNodeIdsByFile(_file: string): NodeIdRow[] {
    throw new Error('not implemented');
  }

  findNodeChildren(_parentId: number): ChildNodeRow[] {
    throw new Error('not implemented');
  }

  findNodesByScope(_scopeName: string, _opts?: QueryOpts): NodeRow[] {
    throw new Error('not implemented');
  }

  findNodeByQualifiedName(_qualifiedName: string, _opts?: { file?: string }): NodeRow[] {
    throw new Error('not implemented');
  }

  listFunctionNodes(_opts?: ListFunctionOpts): NodeRow[] {
    throw new Error('not implemented');
  }

  iterateFunctionNodes(_opts?: ListFunctionOpts): IterableIterator<NodeRow> {
    throw new Error('not implemented');
  }

  findNodesForTriage(_opts?: TriageQueryOpts): TriageNodeRow[] {
    throw new Error('not implemented');
  }

  // ── Edge queries ────────────────────────────────────────────────────
  findCallees(_nodeId: number): RelatedNodeRow[] {
    throw new Error('not implemented');
  }

  findCallers(_nodeId: number): RelatedNodeRow[] {
    throw new Error('not implemented');
  }

  findDistinctCallers(_nodeId: number): RelatedNodeRow[] {
    throw new Error('not implemented');
  }

  findAllOutgoingEdges(_nodeId: number): AdjacentEdgeRow[] {
    throw new Error('not implemented');
  }

  findAllIncomingEdges(_nodeId: number): AdjacentEdgeRow[] {
    throw new Error('not implemented');
  }

  findCalleeNames(_nodeId: number): string[] {
    throw new Error('not implemented');
  }

  findCallerNames(_nodeId: number): string[] {
    throw new Error('not implemented');
  }

  findImportTargets(_nodeId: number): ImportEdgeRow[] {
    throw new Error('not implemented');
  }

  findImportSources(_nodeId: number): ImportEdgeRow[] {
    throw new Error('not implemented');
  }

  findImportDependents(_nodeId: number): NodeRow[] {
    throw new Error('not implemented');
  }

  findCrossFileCallTargets(_file: string): Set<number> {
    throw new Error('not implemented');
  }

  countCrossFileCallers(_nodeId: number, _file: string): number {
    throw new Error('not implemented');
  }

  getClassHierarchy(_classNodeId: number): Set<number> {
    throw new Error('not implemented');
  }

  findImplementors(_nodeId: number): RelatedNodeRow[] {
    throw new Error('not implemented');
  }

  findInterfaces(_nodeId: number): RelatedNodeRow[] {
    throw new Error('not implemented');
  }

  findIntraFileCallEdges(_file: string): IntraFileCallEdge[] {
    throw new Error('not implemented');
  }

  // ── Graph-read queries ──────────────────────────────────────────────
  getCallableNodes(): CallableNodeRow[] {
    throw new Error('not implemented');
  }

  getCallEdges(): CallEdgeRow[] {
    throw new Error('not implemented');
  }

  getFileNodesAll(): FileNodeRow[] {
    throw new Error('not implemented');
  }

  getImportEdges(): ImportGraphEdgeRow[] {
    throw new Error('not implemented');
  }

  // ── Optional table checks (default: false/undefined) ────────────────
  hasCfgTables(): boolean {
    throw new Error('not implemented');
  }

  hasEmbeddings(): boolean {
    throw new Error('not implemented');
  }

  hasDataflowTable(): boolean {
    throw new Error('not implemented');
  }

  getComplexityForNode(_nodeId: number): ComplexityMetrics | undefined {
    throw new Error('not implemented');
  }

  // ── Convenience queries ──────────────────────────────────────────────
  /**
   * Look up the stored content hash for a file.
   * Returns null when the file is not in file_hashes or the method is
   * not yet implemented on the concrete repository.
   */
  getFileHash(_file: string): string | null {
    return null;
  }

  /** Check whether the graph contains any 'implements' edges. */
  hasImplementsEdges(): boolean {
    return false;
  }

  /** Check whether the co_changes table exists and has data. */
  hasCoChangesTable(): boolean {
    return false;
  }
}
