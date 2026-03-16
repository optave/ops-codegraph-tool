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
  findImportDependents,
  findImportSources,
  findImportTargets,
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
  #db;

  /** @param {object} db - better-sqlite3 Database instance */
  constructor(db) {
    super();
    this.#db = db;
  }

  /** Expose the underlying db for code that still needs raw access. */
  get db() {
    return this.#db;
  }

  // ── Node lookups ──────────────────────────────────────────────────

  findNodeById(id) {
    return findNodeById(this.#db, id);
  }

  findNodesByFile(file) {
    return findNodesByFile(this.#db, file);
  }

  findFileNodes(fileLike) {
    return findFileNodes(this.#db, fileLike);
  }

  findNodesWithFanIn(namePattern, opts) {
    return findNodesWithFanIn(this.#db, namePattern, opts);
  }

  countNodes() {
    return countNodes(this.#db);
  }

  countEdges() {
    return countEdges(this.#db);
  }

  countFiles() {
    return countFiles(this.#db);
  }

  getNodeId(name, kind, file, line) {
    return getNodeId(this.#db, name, kind, file, line);
  }

  getFunctionNodeId(name, file, line) {
    return getFunctionNodeId(this.#db, name, file, line);
  }

  bulkNodeIdsByFile(file) {
    return bulkNodeIdsByFile(this.#db, file);
  }

  findNodeChildren(parentId) {
    return findNodeChildren(this.#db, parentId);
  }

  findNodesByScope(scopeName, opts) {
    return findNodesByScope(this.#db, scopeName, opts);
  }

  findNodeByQualifiedName(qualifiedName, opts) {
    return findNodeByQualifiedName(this.#db, qualifiedName, opts);
  }

  listFunctionNodes(opts) {
    return listFunctionNodes(this.#db, opts);
  }

  iterateFunctionNodes(opts) {
    return iterateFunctionNodes(this.#db, opts);
  }

  findNodesForTriage(opts) {
    return findNodesForTriage(this.#db, opts);
  }

  // ── Edge queries ──────────────────────────────────────────────────

  findCallees(nodeId) {
    return findCallees(this.#db, nodeId);
  }

  findCallers(nodeId) {
    return findCallers(this.#db, nodeId);
  }

  findDistinctCallers(nodeId) {
    return findDistinctCallers(this.#db, nodeId);
  }

  findAllOutgoingEdges(nodeId) {
    return findAllOutgoingEdges(this.#db, nodeId);
  }

  findAllIncomingEdges(nodeId) {
    return findAllIncomingEdges(this.#db, nodeId);
  }

  findCalleeNames(nodeId) {
    return findCalleeNames(this.#db, nodeId);
  }

  findCallerNames(nodeId) {
    return findCallerNames(this.#db, nodeId);
  }

  findImportTargets(nodeId) {
    return findImportTargets(this.#db, nodeId);
  }

  findImportSources(nodeId) {
    return findImportSources(this.#db, nodeId);
  }

  findImportDependents(nodeId) {
    return findImportDependents(this.#db, nodeId);
  }

  findCrossFileCallTargets(file) {
    return findCrossFileCallTargets(this.#db, file);
  }

  countCrossFileCallers(nodeId, file) {
    return countCrossFileCallers(this.#db, nodeId, file);
  }

  getClassHierarchy(classNodeId) {
    return getClassHierarchy(this.#db, classNodeId);
  }

  findIntraFileCallEdges(file) {
    return findIntraFileCallEdges(this.#db, file);
  }

  // ── Graph-read queries ────────────────────────────────────────────

  getCallableNodes() {
    return getCallableNodes(this.#db);
  }

  getCallEdges() {
    return getCallEdges(this.#db);
  }

  getFileNodesAll() {
    return getFileNodesAll(this.#db);
  }

  getImportEdges() {
    return getImportEdges(this.#db);
  }

  // ── Optional table checks ─────────────────────────────────────────

  hasCfgTables() {
    return hasCfgTables(this.#db);
  }

  hasEmbeddings() {
    return hasEmbeddings(this.#db);
  }

  hasDataflowTable() {
    return hasDataflowTable(this.#db);
  }

  getComplexityForNode(nodeId) {
    return getComplexityForNode(this.#db, nodeId);
  }
}
