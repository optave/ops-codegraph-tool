import { ConfigError } from '../../errors.js';
import { CORE_SYMBOL_KINDS, EVERY_SYMBOL_KIND, VALID_ROLES } from '../../kinds.js';
import { Repository } from './base.js';

/**
 * Convert a SQL LIKE pattern to a RegExp (case-insensitive).
 * Supports `%` (any chars) and `_` (single char).
 * @param {string} pattern
 * @returns {RegExp}
 */
function likeToRegex(pattern) {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      // Escaped literal
      regex += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '%') {
      regex += '.*';
    } else if (ch === '_') {
      regex += '.';
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${regex}$`, 'i');
}

/**
 * In-memory Repository implementation backed by Maps.
 * No SQLite dependency — suitable for fast unit tests.
 */
export class InMemoryRepository extends Repository {
  #nodes = new Map(); // id → node object
  #edges = new Map(); // id → edge object
  #complexity = new Map(); // node_id → complexity metrics
  #nextNodeId = 1;
  #nextEdgeId = 1;

  // ── Mutation (test setup only) ────────────────────────────────────

  /**
   * Add a node. Returns the auto-assigned id.
   * @param {object} attrs - { name, kind, file, line, end_line?, parent_id?, exported?, qualified_name?, scope?, visibility?, role? }
   * @returns {number}
   */
  addNode(attrs) {
    const id = this.#nextNodeId++;
    this.#nodes.set(id, {
      id,
      name: attrs.name,
      kind: attrs.kind,
      file: attrs.file,
      line: attrs.line,
      end_line: attrs.end_line ?? null,
      parent_id: attrs.parent_id ?? null,
      exported: attrs.exported ?? null,
      qualified_name: attrs.qualified_name ?? null,
      scope: attrs.scope ?? null,
      visibility: attrs.visibility ?? null,
      role: attrs.role ?? null,
    });
    return id;
  }

  /**
   * Add an edge. Returns the auto-assigned id.
   * @param {object} attrs - { source_id, target_id, kind, confidence?, dynamic? }
   * @returns {number}
   */
  addEdge(attrs) {
    const id = this.#nextEdgeId++;
    this.#edges.set(id, {
      id,
      source_id: attrs.source_id,
      target_id: attrs.target_id,
      kind: attrs.kind,
      confidence: attrs.confidence ?? null,
      dynamic: attrs.dynamic ?? 0,
    });
    return id;
  }

  /**
   * Add complexity metrics for a node.
   * @param {number} nodeId
   * @param {object} metrics - { cognitive, cyclomatic, max_nesting, maintainability_index?, halstead_volume? }
   */
  addComplexity(nodeId, metrics) {
    this.#complexity.set(nodeId, {
      cognitive: metrics.cognitive ?? 0,
      cyclomatic: metrics.cyclomatic ?? 0,
      max_nesting: metrics.max_nesting ?? 0,
      maintainability_index: metrics.maintainability_index ?? 0,
      halstead_volume: metrics.halstead_volume ?? 0,
    });
  }

  // ── Node lookups ──────────────────────────────────────────────────

  findNodeById(id) {
    return this.#nodes.get(id) ?? undefined;
  }

  findNodesByFile(file) {
    return [...this.#nodes.values()]
      .filter((n) => n.file === file && n.kind !== 'file')
      .sort((a, b) => a.line - b.line);
  }

  findFileNodes(fileLike) {
    const re = likeToRegex(fileLike);
    return [...this.#nodes.values()].filter((n) => n.kind === 'file' && re.test(n.file));
  }

  findNodesWithFanIn(namePattern, opts = {}) {
    const re = likeToRegex(namePattern);
    let nodes = [...this.#nodes.values()].filter((n) => re.test(n.name));

    if (opts.kinds) {
      nodes = nodes.filter((n) => opts.kinds.includes(n.kind));
    }
    if (opts.file) {
      const fileRe = likeToRegex(`%${opts.file}%`);
      nodes = nodes.filter((n) => fileRe.test(n.file));
    }

    // Compute fan-in per node
    const fanInMap = this.#computeFanIn();
    return nodes.map((n) => ({ ...n, fan_in: fanInMap.get(n.id) ?? 0 }));
  }

  countNodes() {
    return this.#nodes.size;
  }

  countEdges() {
    return this.#edges.size;
  }

  countFiles() {
    const files = new Set();
    for (const n of this.#nodes.values()) {
      files.add(n.file);
    }
    return files.size;
  }

  getNodeId(name, kind, file, line) {
    for (const n of this.#nodes.values()) {
      if (n.name === name && n.kind === kind && n.file === file && n.line === line) {
        return n.id;
      }
    }
    return undefined;
  }

  getFunctionNodeId(name, file, line) {
    for (const n of this.#nodes.values()) {
      if (
        n.name === name &&
        (n.kind === 'function' || n.kind === 'method') &&
        n.file === file &&
        n.line === line
      ) {
        return n.id;
      }
    }
    return undefined;
  }

  bulkNodeIdsByFile(file) {
    return [...this.#nodes.values()]
      .filter((n) => n.file === file)
      .map((n) => ({ id: n.id, name: n.name, kind: n.kind, line: n.line }));
  }

  findNodeChildren(parentId) {
    return [...this.#nodes.values()]
      .filter((n) => n.parent_id === parentId)
      .sort((a, b) => a.line - b.line)
      .map((n) => ({
        name: n.name,
        kind: n.kind,
        line: n.line,
        end_line: n.end_line,
        qualified_name: n.qualified_name,
        scope: n.scope,
        visibility: n.visibility,
      }));
  }

  findNodesByScope(scopeName, opts = {}) {
    let nodes = [...this.#nodes.values()].filter((n) => n.scope === scopeName);

    if (opts.kind) {
      nodes = nodes.filter((n) => n.kind === opts.kind);
    }
    if (opts.file) {
      const fileRe = likeToRegex(`%${opts.file}%`);
      nodes = nodes.filter((n) => fileRe.test(n.file));
    }

    return nodes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  findNodeByQualifiedName(qualifiedName, opts = {}) {
    let nodes = [...this.#nodes.values()].filter((n) => n.qualified_name === qualifiedName);

    if (opts.file) {
      const fileRe = likeToRegex(`%${opts.file}%`);
      nodes = nodes.filter((n) => fileRe.test(n.file));
    }

    return nodes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  listFunctionNodes(opts = {}) {
    return [...this.#iterateFunctionNodesImpl(opts)];
  }

  *iterateFunctionNodes(opts = {}) {
    yield* this.#iterateFunctionNodesImpl(opts);
  }

  findNodesForTriage(opts = {}) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      throw new ConfigError(
        `Invalid kind: ${opts.kind} (expected one of ${EVERY_SYMBOL_KIND.join(', ')})`,
      );
    }
    if (opts.role && !VALID_ROLES.includes(opts.role)) {
      throw new ConfigError(
        `Invalid role: ${opts.role} (expected one of ${VALID_ROLES.join(', ')})`,
      );
    }
    const kindsToUse = opts.kind ? [opts.kind] : ['function', 'method', 'class'];
    let nodes = [...this.#nodes.values()].filter((n) => kindsToUse.includes(n.kind));

    if (opts.noTests) {
      nodes = nodes.filter((n) => !n.file.includes('.test.') && !n.file.includes('.spec.'));
    }
    if (opts.file) {
      const fileRe = likeToRegex(`%${opts.file}%`);
      nodes = nodes.filter((n) => fileRe.test(n.file));
    }
    if (opts.role) {
      nodes = nodes.filter((n) => n.role === opts.role);
    }

    const fanInMap = this.#computeFanIn();
    return nodes
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map((n) => {
        const cx = this.#complexity.get(n.id);
        return {
          id: n.id,
          name: n.name,
          kind: n.kind,
          file: n.file,
          line: n.line,
          end_line: n.end_line,
          role: n.role,
          fan_in: fanInMap.get(n.id) ?? 0,
          cognitive: cx?.cognitive ?? 0,
          mi: cx?.maintainability_index ?? 0,
          cyclomatic: cx?.cyclomatic ?? 0,
          max_nesting: cx?.max_nesting ?? 0,
          churn: 0, // no co-change data in-memory
        };
      });
  }

  // ── Edge queries ──────────────────────────────────────────────────

  findCallees(nodeId) {
    const seen = new Set();
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.source_id === nodeId && e.kind === 'calls' && !seen.has(e.target_id)) {
        seen.add(e.target_id);
        const n = this.#nodes.get(e.target_id);
        if (n)
          results.push({
            id: n.id,
            name: n.name,
            kind: n.kind,
            file: n.file,
            line: n.line,
            end_line: n.end_line,
          });
      }
    }
    return results;
  }

  findCallers(nodeId) {
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls') {
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line });
      }
    }
    return results;
  }

  findDistinctCallers(nodeId) {
    const seen = new Set();
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls' && !seen.has(e.source_id)) {
        seen.add(e.source_id);
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line });
      }
    }
    return results;
  }

  findAllOutgoingEdges(nodeId) {
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.source_id === nodeId) {
        const n = this.#nodes.get(e.target_id);
        if (n)
          results.push({
            name: n.name,
            kind: n.kind,
            file: n.file,
            line: n.line,
            edge_kind: e.kind,
          });
      }
    }
    return results;
  }

  findAllIncomingEdges(nodeId) {
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId) {
        const n = this.#nodes.get(e.source_id);
        if (n)
          results.push({
            name: n.name,
            kind: n.kind,
            file: n.file,
            line: n.line,
            edge_kind: e.kind,
          });
      }
    }
    return results;
  }

  findCalleeNames(nodeId) {
    const names = new Set();
    for (const e of this.#edges.values()) {
      if (e.source_id === nodeId && e.kind === 'calls') {
        const n = this.#nodes.get(e.target_id);
        if (n) names.add(n.name);
      }
    }
    return [...names].sort();
  }

  findCallerNames(nodeId) {
    const names = new Set();
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls') {
        const n = this.#nodes.get(e.source_id);
        if (n) names.add(n.name);
      }
    }
    return [...names].sort();
  }

  findImportTargets(nodeId) {
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.source_id === nodeId && (e.kind === 'imports' || e.kind === 'imports-type')) {
        const n = this.#nodes.get(e.target_id);
        if (n) results.push({ file: n.file, edge_kind: e.kind });
      }
    }
    return results;
  }

  findImportSources(nodeId) {
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && (e.kind === 'imports' || e.kind === 'imports-type')) {
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ file: n.file, edge_kind: e.kind });
      }
    }
    return results;
  }

  findImportDependents(nodeId) {
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && (e.kind === 'imports' || e.kind === 'imports-type')) {
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ ...n });
      }
    }
    return results;
  }

  findCrossFileCallTargets(file) {
    const targets = new Set();
    for (const e of this.#edges.values()) {
      if (e.kind !== 'calls') continue;
      const caller = this.#nodes.get(e.source_id);
      const target = this.#nodes.get(e.target_id);
      if (caller && target && target.file === file && caller.file !== file) {
        targets.add(e.target_id);
      }
    }
    return targets;
  }

  countCrossFileCallers(nodeId, file) {
    let count = 0;
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls') {
        const caller = this.#nodes.get(e.source_id);
        if (caller && caller.file !== file) count++;
      }
    }
    return count;
  }

  getClassHierarchy(classNodeId) {
    const ancestors = new Set();
    const queue = [classNodeId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const e of this.#edges.values()) {
        if (e.source_id === current && e.kind === 'extends') {
          const target = this.#nodes.get(e.target_id);
          if (target && !ancestors.has(target.id)) {
            ancestors.add(target.id);
            queue.push(target.id);
          }
        }
      }
    }
    return ancestors;
  }

  findIntraFileCallEdges(file) {
    const results = [];
    for (const e of this.#edges.values()) {
      if (e.kind !== 'calls') continue;
      const caller = this.#nodes.get(e.source_id);
      const callee = this.#nodes.get(e.target_id);
      if (caller && callee && caller.file === file && callee.file === file) {
        results.push({ caller_name: caller.name, callee_name: callee.name });
      }
    }
    const lineByName = new Map();
    for (const n of this.#nodes.values()) {
      if (n.file === file) lineByName.set(n.name, n.line);
    }
    return results.sort((a, b) => {
      return (lineByName.get(a.caller_name) ?? 0) - (lineByName.get(b.caller_name) ?? 0);
    });
  }

  // ── Graph-read queries ────────────────────────────────────────────

  getCallableNodes() {
    return [...this.#nodes.values()]
      .filter((n) => CORE_SYMBOL_KINDS.includes(n.kind))
      .map((n) => ({ id: n.id, name: n.name, kind: n.kind, file: n.file }));
  }

  getCallEdges() {
    return [...this.#edges.values()]
      .filter((e) => e.kind === 'calls')
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id }));
  }

  getFileNodesAll() {
    return [...this.#nodes.values()]
      .filter((n) => n.kind === 'file')
      .map((n) => ({ id: n.id, name: n.name, file: n.file }));
  }

  getImportEdges() {
    return [...this.#edges.values()]
      .filter((e) => e.kind === 'imports' || e.kind === 'imports-type')
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id }));
  }

  // ── Optional table checks ─────────────────────────────────────────

  hasCfgTables() {
    return false;
  }

  hasEmbeddings() {
    return false;
  }

  hasDataflowTable() {
    return false;
  }

  getComplexityForNode(nodeId) {
    return this.#complexity.get(nodeId);
  }

  // ── Private helpers ───────────────────────────────────────────────

  /** Compute fan-in (incoming 'calls' edge count) for all nodes. */
  #computeFanIn() {
    const fanIn = new Map();
    for (const e of this.#edges.values()) {
      if (e.kind === 'calls') {
        fanIn.set(e.target_id, (fanIn.get(e.target_id) ?? 0) + 1);
      }
    }
    return fanIn;
  }

  /** Internal generator for function/method/class listing with filters. */
  *#iterateFunctionNodesImpl(opts = {}) {
    let nodes = [...this.#nodes.values()].filter((n) =>
      ['function', 'method', 'class'].includes(n.kind),
    );

    if (opts.file) {
      const fileRe = likeToRegex(`%${opts.file}%`);
      nodes = nodes.filter((n) => fileRe.test(n.file));
    }
    if (opts.pattern) {
      const patternRe = likeToRegex(`%${opts.pattern}%`);
      nodes = nodes.filter((n) => patternRe.test(n.name));
    }
    if (opts.noTests) {
      nodes = nodes.filter((n) => !n.file.includes('.test.') && !n.file.includes('.spec.'));
    }

    nodes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    for (const n of nodes) {
      yield {
        name: n.name,
        kind: n.kind,
        file: n.file,
        line: n.line,
        end_line: n.end_line,
        role: n.role,
      };
    }
  }
}
