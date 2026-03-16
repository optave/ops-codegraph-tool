/**
 * Abstract Repository base class.
 *
 * Defines the contract for all graph data access. Every method throws
 * "not implemented" by default — concrete subclasses override what they support.
 */
export class Repository {
  // ── Node lookups ────────────────────────────────────────────────────
  /** @param {number} id @returns {object|undefined} */
  findNodeById(_id) {
    throw new Error('not implemented');
  }

  /** @param {string} file @returns {object[]} */
  findNodesByFile(_file) {
    throw new Error('not implemented');
  }

  /** @param {string} fileLike @returns {object[]} */
  findFileNodes(_fileLike) {
    throw new Error('not implemented');
  }

  /** @param {string} namePattern @param {object} [opts] @returns {object[]} */
  findNodesWithFanIn(_namePattern, _opts) {
    throw new Error('not implemented');
  }

  /** @returns {number} */
  countNodes() {
    throw new Error('not implemented');
  }

  /** @returns {number} */
  countEdges() {
    throw new Error('not implemented');
  }

  /** @returns {number} */
  countFiles() {
    throw new Error('not implemented');
  }

  /** @param {string} name @param {string} kind @param {string} file @param {number} line @returns {number|undefined} */
  getNodeId(_name, _kind, _file, _line) {
    throw new Error('not implemented');
  }

  /** @param {string} name @param {string} file @param {number} line @returns {number|undefined} */
  getFunctionNodeId(_name, _file, _line) {
    throw new Error('not implemented');
  }

  /** @param {string} file @returns {{ id: number, name: string, kind: string, line: number }[]} */
  bulkNodeIdsByFile(_file) {
    throw new Error('not implemented');
  }

  /** @param {number} parentId @returns {object[]} */
  findNodeChildren(_parentId) {
    throw new Error('not implemented');
  }

  /** @param {string} scopeName @param {object} [opts] @returns {object[]} */
  findNodesByScope(_scopeName, _opts) {
    throw new Error('not implemented');
  }

  /** @param {string} qualifiedName @param {object} [opts] @returns {object[]} */
  findNodeByQualifiedName(_qualifiedName, _opts) {
    throw new Error('not implemented');
  }

  /** @param {object} [opts] @returns {object[]} */
  listFunctionNodes(_opts) {
    throw new Error('not implemented');
  }

  /** @param {object} [opts] @returns {IterableIterator} */
  iterateFunctionNodes(_opts) {
    throw new Error('not implemented');
  }

  /** @param {object} [opts] @returns {object[]} */
  findNodesForTriage(_opts) {
    throw new Error('not implemented');
  }

  // ── Edge queries ────────────────────────────────────────────────────
  /** @param {number} nodeId @returns {object[]} */
  findCallees(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {object[]} */
  findCallers(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {object[]} */
  findDistinctCallers(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {object[]} */
  findAllOutgoingEdges(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {object[]} */
  findAllIncomingEdges(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {string[]} */
  findCalleeNames(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {string[]} */
  findCallerNames(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {{ file: string, edge_kind: string }[]} */
  findImportTargets(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {{ file: string, edge_kind: string }[]} */
  findImportSources(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {object[]} */
  findImportDependents(_nodeId) {
    throw new Error('not implemented');
  }

  /** @param {string} file @returns {Set<number>} */
  findCrossFileCallTargets(_file) {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @param {string} file @returns {number} */
  countCrossFileCallers(_nodeId, _file) {
    throw new Error('not implemented');
  }

  /** @param {number} classNodeId @returns {Set<number>} */
  getClassHierarchy(_classNodeId) {
    throw new Error('not implemented');
  }

  /** @param {string} file @returns {{ caller_name: string, callee_name: string }[]} */
  findIntraFileCallEdges(_file) {
    throw new Error('not implemented');
  }

  // ── Graph-read queries ──────────────────────────────────────────────
  /** @returns {{ id: number, name: string, kind: string, file: string }[]} */
  getCallableNodes() {
    throw new Error('not implemented');
  }

  /** @returns {{ source_id: number, target_id: number }[]} */
  getCallEdges() {
    throw new Error('not implemented');
  }

  /** @returns {{ id: number, name: string, file: string }[]} */
  getFileNodesAll() {
    throw new Error('not implemented');
  }

  /** @returns {{ source_id: number, target_id: number }[]} */
  getImportEdges() {
    throw new Error('not implemented');
  }

  // ── Optional table checks (default: false/undefined) ────────────────
  /** @returns {boolean} */
  hasCfgTables() {
    throw new Error('not implemented');
  }

  /** @returns {boolean} */
  hasEmbeddings() {
    throw new Error('not implemented');
  }

  /** @returns {boolean} */
  hasDataflowTable() {
    throw new Error('not implemented');
  }

  /** @param {number} nodeId @returns {object|undefined} */
  getComplexityForNode(_nodeId) {
    throw new Error('not implemented');
  }
}
