import type {
  AdjacentEdgeRow,
  BetterSqlite3Database,
  CallableNodeRow,
  CallEdgeRow,
  ChildNodeRow,
  ComplexityMetrics,
  FileNodeRow,
  ImportEdgeRow,
  ImportGraphEdgeRow,
  IntraFileCallEdge,
  ListFunctionOpts,
  NodeIdRow,
  NodeRow,
  NodeRowWithFanIn,
  QueryOpts,
  RelatedNodeRow,
  TriageQueryOpts,
} from '../../types.js';
import { Repository } from './base.js';
import { hasCfgTables } from './cfg.js';
import { getComplexityForNode } from './complexity.js';
import { hasDataflowTable } from './dataflow.js';
import {
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
import { hasEmbeddings } from './embeddings.js';
import { getCallableNodes, getCallEdges, getFileNodesAll, getImportEdges } from './graph-read.js';
import {
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
  getNodeId,
  iterateFunctionNodes,
  listFunctionNodes,
} from './nodes.js';

/**
 * SqliteRepository — wraps existing `fn(db, ...)` repository functions
 * behind the Repository interface so callers can use `repo.method(...)`.
 */
export class SqliteRepository extends Repository {
  #db: BetterSqlite3Database;

  constructor(db: BetterSqlite3Database) {
    super();
    this.#db = db;
  }

  /** Expose the underlying db for code that still needs raw access. */
  get db(): BetterSqlite3Database {
    return this.#db;
  }

  // ── Node lookups ──────────────────────────────────────────────────

  findNodeById(id: number): NodeRow | undefined {
    return findNodeById(this.#db, id);
  }

  findNodesByFile(file: string): NodeRow[] {
    return findNodesByFile(this.#db, file);
  }

  findFileNodes(fileLike: string): NodeRow[] {
    return findFileNodes(this.#db, fileLike);
  }

  findNodesWithFanIn(namePattern: string, opts?: QueryOpts): NodeRowWithFanIn[] {
    return findNodesWithFanIn(this.#db, namePattern, opts);
  }

  countNodes(): number {
    return countNodes(this.#db);
  }

  countEdges(): number {
    return countEdges(this.#db);
  }

  countFiles(): number {
    return countFiles(this.#db);
  }

  getNodeId(name: string, kind: string, file: string, line: number): number | undefined {
    return getNodeId(this.#db, name, kind, file, line);
  }

  getFunctionNodeId(name: string, file: string, line: number): number | undefined {
    return getFunctionNodeId(this.#db, name, file, line);
  }

  bulkNodeIdsByFile(file: string): NodeIdRow[] {
    return bulkNodeIdsByFile(this.#db, file);
  }

  findNodeChildren(parentId: number): ChildNodeRow[] {
    return findNodeChildren(this.#db, parentId);
  }

  findNodesByScope(scopeName: string, opts?: QueryOpts): NodeRow[] {
    return findNodesByScope(this.#db, scopeName, opts);
  }

  findNodeByQualifiedName(qualifiedName: string, opts?: { file?: string }): NodeRow[] {
    return findNodeByQualifiedName(this.#db, qualifiedName, opts);
  }

  listFunctionNodes(opts?: ListFunctionOpts): NodeRow[] {
    return listFunctionNodes(this.#db, opts);
  }

  iterateFunctionNodes(opts?: ListFunctionOpts): IterableIterator<NodeRow> {
    return iterateFunctionNodes(this.#db, opts);
  }

  findNodesForTriage(opts?: TriageQueryOpts): NodeRow[] {
    return findNodesForTriage(this.#db, opts);
  }

  // ── Edge queries ──────────────────────────────────────────────────

  findCallees(nodeId: number): RelatedNodeRow[] {
    return findCallees(this.#db, nodeId);
  }

  findCallers(nodeId: number): RelatedNodeRow[] {
    return findCallers(this.#db, nodeId);
  }

  findDistinctCallers(nodeId: number): RelatedNodeRow[] {
    return findDistinctCallers(this.#db, nodeId);
  }

  findAllOutgoingEdges(nodeId: number): AdjacentEdgeRow[] {
    return findAllOutgoingEdges(this.#db, nodeId);
  }

  findAllIncomingEdges(nodeId: number): AdjacentEdgeRow[] {
    return findAllIncomingEdges(this.#db, nodeId);
  }

  findCalleeNames(nodeId: number): string[] {
    return findCalleeNames(this.#db, nodeId);
  }

  findCallerNames(nodeId: number): string[] {
    return findCallerNames(this.#db, nodeId);
  }

  findImportTargets(nodeId: number): ImportEdgeRow[] {
    return findImportTargets(this.#db, nodeId);
  }

  findImportSources(nodeId: number): ImportEdgeRow[] {
    return findImportSources(this.#db, nodeId);
  }

  findImportDependents(nodeId: number): NodeRow[] {
    return findImportDependents(this.#db, nodeId);
  }

  findCrossFileCallTargets(file: string): Set<number> {
    return findCrossFileCallTargets(this.#db, file);
  }

  countCrossFileCallers(nodeId: number, file: string): number {
    return countCrossFileCallers(this.#db, nodeId, file);
  }

  getClassHierarchy(classNodeId: number): Set<number> {
    return getClassHierarchy(this.#db, classNodeId);
  }

  findImplementors(nodeId: number): RelatedNodeRow[] {
    return findImplementors(this.#db, nodeId);
  }

  findInterfaces(nodeId: number): RelatedNodeRow[] {
    return findInterfaces(this.#db, nodeId);
  }

  findIntraFileCallEdges(file: string): IntraFileCallEdge[] {
    return findIntraFileCallEdges(this.#db, file);
  }

  // ── Graph-read queries ────────────────────────────────────────────

  getCallableNodes(): CallableNodeRow[] {
    return getCallableNodes(this.#db);
  }

  getCallEdges(): CallEdgeRow[] {
    return getCallEdges(this.#db);
  }

  getFileNodesAll(): FileNodeRow[] {
    return getFileNodesAll(this.#db);
  }

  getImportEdges(): ImportGraphEdgeRow[] {
    return getImportEdges(this.#db);
  }

  // ── Optional table checks ─────────────────────────────────────────

  hasCfgTables(): boolean {
    return hasCfgTables(this.#db);
  }

  hasEmbeddings(): boolean {
    return hasEmbeddings(this.#db);
  }

  hasDataflowTable(): boolean {
    return hasDataflowTable(this.#db);
  }

  getComplexityForNode(nodeId: number): ComplexityMetrics | undefined {
    return getComplexityForNode(this.#db, nodeId);
  }
}
