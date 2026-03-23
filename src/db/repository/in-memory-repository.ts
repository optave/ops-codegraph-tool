import { ConfigError } from '../../shared/errors.js';
import {
  CORE_SYMBOL_KINDS,
  DEAD_ROLE_PREFIX,
  EVERY_SYMBOL_KIND,
  VALID_ROLES,
} from '../../shared/kinds.js';
import type {
  AdjacentEdgeRow,
  AnyEdgeKind,
  AnyNodeKind,
  CallableNodeRow,
  CallEdgeRow,
  ChildNodeRow,
  ComplexityMetrics,
  EdgeRow,
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
  Role,
  TriageNodeRow,
  TriageQueryOpts,
} from '../../types.js';
import { escapeLike, normalizeFileFilter } from '../query-builder.js';
import { Repository } from './base.js';

/**
 * Convert a SQL LIKE pattern to a RegExp (case-insensitive).
 * Supports `%` (any chars) and `_` (single char).
 */
function likeToRegex(pattern: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      // Escaped literal
      regex += pattern[++i]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * Build a filter predicate for file matching.
 * Accepts string, string[], or falsy. Returns null when no filtering needed.
 */
function buildFileFilterFn(
  file: string | string[] | undefined,
): ((filePath: string) => boolean) | null {
  const files = normalizeFileFilter(file);
  if (files.length === 0) return null;
  const regexes = files.map((f: string) => likeToRegex(`%${escapeLike(f)}%`));
  return (filePath: string) => regexes.some((re: RegExp) => re.test(filePath));
}

/**
 * In-memory Repository implementation backed by Maps.
 * No SQLite dependency — suitable for fast unit tests.
 */
export class InMemoryRepository extends Repository {
  #nodes = new Map<number, NodeRow>();
  #edges = new Map<number, EdgeRow>();
  #complexity = new Map<number, ComplexityMetrics>();
  #nextNodeId = 1;
  #nextEdgeId = 1;

  // ── Mutation (test setup only) ────────────────────────────────────

  /**
   * Add a node. Returns the auto-assigned id.
   */
  addNode(attrs: {
    name: string;
    kind: AnyNodeKind;
    file: string;
    line: number;
    end_line?: number;
    parent_id?: number;
    exported?: 0 | 1;
    qualified_name?: string;
    scope?: string;
    visibility?: 'public' | 'private' | 'protected';
    role?: Role;
  }): number {
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
   */
  addEdge(attrs: {
    source_id: number;
    target_id: number;
    kind: AnyEdgeKind;
    confidence?: number;
    dynamic?: 0 | 1;
  }): number {
    const id = this.#nextEdgeId++;
    this.#edges.set(id, {
      id,
      source_id: attrs.source_id,
      target_id: attrs.target_id,
      kind: attrs.kind as EdgeRow['kind'],
      confidence: attrs.confidence ?? null,
      dynamic: attrs.dynamic ?? 0,
    });
    return id;
  }

  /**
   * Add complexity metrics for a node.
   */
  addComplexity(
    nodeId: number,
    metrics: {
      cognitive: number;
      cyclomatic: number;
      max_nesting: number;
      maintainability_index?: number;
      halstead_volume?: number;
    },
  ): void {
    this.#complexity.set(nodeId, {
      cognitive: metrics.cognitive ?? 0,
      cyclomatic: metrics.cyclomatic ?? 0,
      max_nesting: metrics.max_nesting ?? 0,
      maintainability_index: metrics.maintainability_index ?? 0,
      halstead_volume: metrics.halstead_volume ?? 0,
    });
  }

  // ── Node lookups ──────────────────────────────────────────────────

  findNodeById(id: number): NodeRow | undefined {
    return this.#nodes.get(id) ?? undefined;
  }

  findNodesByFile(file: string): NodeRow[] {
    return [...this.#nodes.values()]
      .filter((n) => n.file === file && n.kind !== 'file')
      .sort((a, b) => a.line - b.line);
  }

  findFileNodes(fileLike: string): NodeRow[] {
    const re = likeToRegex(fileLike);
    return [...this.#nodes.values()].filter((n) => n.kind === 'file' && re.test(n.file));
  }

  findNodesWithFanIn(namePattern: string, opts: QueryOpts = {}): NodeRowWithFanIn[] {
    const re = likeToRegex(namePattern);
    let nodes = [...this.#nodes.values()].filter((n) => re.test(n.name));

    if (opts.kinds) {
      nodes = nodes.filter((n) =>
        opts.kinds?.includes(n.kind as import('../../types.js').SymbolKind),
      );
    }
    {
      const fileFn = buildFileFilterFn(opts.file);
      if (fileFn) nodes = nodes.filter((n) => fileFn(n.file));
    }

    // Compute fan-in per node
    const fanInMap = this.#computeFanIn();
    return nodes.map((n) => ({ ...n, fan_in: fanInMap.get(n.id) ?? 0 }));
  }

  countNodes(): number {
    return this.#nodes.size;
  }

  countEdges(): number {
    return this.#edges.size;
  }

  countFiles(): number {
    const files = new Set<string>();
    for (const n of this.#nodes.values()) {
      files.add(n.file);
    }
    return files.size;
  }

  getNodeId(name: string, kind: string, file: string, line: number): number | undefined {
    for (const n of this.#nodes.values()) {
      if (n.name === name && n.kind === kind && n.file === file && n.line === line) {
        return n.id;
      }
    }
    return undefined;
  }

  getFunctionNodeId(name: string, file: string, line: number): number | undefined {
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

  bulkNodeIdsByFile(file: string): NodeIdRow[] {
    return [...this.#nodes.values()]
      .filter((n) => n.file === file)
      .map((n) => ({ id: n.id, name: n.name, kind: n.kind, line: n.line }));
  }

  findNodeChildren(parentId: number): ChildNodeRow[] {
    return [...this.#nodes.values()]
      .filter((n) => n.parent_id === parentId)
      .sort((a, b) => a.line - b.line)
      .map((n) => ({
        name: n.name,
        kind: n.kind as ChildNodeRow['kind'],
        line: n.line,
        end_line: n.end_line,
        qualified_name: n.qualified_name,
        scope: n.scope,
        visibility: n.visibility,
      }));
  }

  findNodesByScope(scopeName: string, opts: QueryOpts = {}): NodeRow[] {
    let nodes = [...this.#nodes.values()].filter((n) => n.scope === scopeName);

    if (opts.kind) {
      nodes = nodes.filter((n) => n.kind === opts.kind);
    }
    {
      const fileFn = buildFileFilterFn(opts.file);
      if (fileFn) nodes = nodes.filter((n) => fileFn(n.file));
    }

    return nodes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  findNodeByQualifiedName(qualifiedName: string, opts: { file?: string } = {}): NodeRow[] {
    let nodes = [...this.#nodes.values()].filter((n) => n.qualified_name === qualifiedName);

    {
      const fileFn = buildFileFilterFn(opts.file);
      if (fileFn) nodes = nodes.filter((n) => fileFn(n.file));
    }

    return nodes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  listFunctionNodes(opts: ListFunctionOpts = {}): NodeRow[] {
    return [...this.#iterateFunctionNodesImpl(opts)];
  }

  *iterateFunctionNodes(opts: ListFunctionOpts = {}): IterableIterator<NodeRow> {
    yield* this.#iterateFunctionNodesImpl(opts);
  }

  findNodesForTriage(opts: TriageQueryOpts = {}): TriageNodeRow[] {
    if (opts.kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(opts.kind)) {
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
      nodes = nodes.filter(
        (n) =>
          !n.file.includes('.test.') &&
          !n.file.includes('.spec.') &&
          !n.file.includes('__test__') &&
          !n.file.includes('__tests__') &&
          !n.file.includes('.stories.'),
      );
    }
    {
      const fileFn = buildFileFilterFn(opts.file);
      if (fileFn) nodes = nodes.filter((n) => fileFn(n.file));
    }
    if (opts.role) {
      nodes = nodes.filter((n) =>
        opts.role === DEAD_ROLE_PREFIX
          ? n.role?.startsWith(DEAD_ROLE_PREFIX)
          : n.role === opts.role,
      );
    }

    const fanInMap = this.#computeFanIn();
    return nodes
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map((n) => {
        const cx = this.#complexity.get(n.id);
        return {
          ...n,
          fan_in: fanInMap.get(n.id) ?? 0,
          cognitive: cx?.cognitive ?? 0,
          mi: cx?.maintainability_index ?? 0,
          cyclomatic: cx?.cyclomatic ?? 0,
          max_nesting: cx?.max_nesting ?? 0,
          churn: 0, // no co-change data in-memory
        } as TriageNodeRow;
      });
  }

  // ── Edge queries ──────────────────────────────────────────────────

  findCallees(nodeId: number): RelatedNodeRow[] {
    const seen = new Set<number>();
    const results: RelatedNodeRow[] = [];
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

  findCallers(nodeId: number): RelatedNodeRow[] {
    const results: RelatedNodeRow[] = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls') {
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line });
      }
    }
    return results;
  }

  findDistinctCallers(nodeId: number): RelatedNodeRow[] {
    const seen = new Set<number>();
    const results: RelatedNodeRow[] = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls' && !seen.has(e.source_id)) {
        seen.add(e.source_id);
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line });
      }
    }
    return results;
  }

  findAllOutgoingEdges(nodeId: number): AdjacentEdgeRow[] {
    const results: AdjacentEdgeRow[] = [];
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

  findAllIncomingEdges(nodeId: number): AdjacentEdgeRow[] {
    const results: AdjacentEdgeRow[] = [];
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

  findCalleeNames(nodeId: number): string[] {
    const names = new Set<string>();
    for (const e of this.#edges.values()) {
      if (e.source_id === nodeId && e.kind === 'calls') {
        const n = this.#nodes.get(e.target_id);
        if (n) names.add(n.name);
      }
    }
    return [...names].sort();
  }

  findCallerNames(nodeId: number): string[] {
    const names = new Set<string>();
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls') {
        const n = this.#nodes.get(e.source_id);
        if (n) names.add(n.name);
      }
    }
    return [...names].sort();
  }

  findImportTargets(nodeId: number): ImportEdgeRow[] {
    const results: ImportEdgeRow[] = [];
    for (const e of this.#edges.values()) {
      if (e.source_id === nodeId && (e.kind === 'imports' || e.kind === 'imports-type')) {
        const n = this.#nodes.get(e.target_id);
        if (n) results.push({ file: n.file, edge_kind: e.kind });
      }
    }
    return results;
  }

  findImportSources(nodeId: number): ImportEdgeRow[] {
    const results: ImportEdgeRow[] = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && (e.kind === 'imports' || e.kind === 'imports-type')) {
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ file: n.file, edge_kind: e.kind });
      }
    }
    return results;
  }

  findImportDependents(nodeId: number): NodeRow[] {
    const results: NodeRow[] = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && (e.kind === 'imports' || e.kind === 'imports-type')) {
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ ...n });
      }
    }
    return results;
  }

  findCrossFileCallTargets(file: string): Set<number> {
    const targets = new Set<number>();
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

  countCrossFileCallers(nodeId: number, file: string): number {
    let count = 0;
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'calls') {
        const caller = this.#nodes.get(e.source_id);
        if (caller && caller.file !== file) count++;
      }
    }
    return count;
  }

  getClassHierarchy(classNodeId: number): Set<number> {
    const ancestors = new Set<number>();
    const queue = [classNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
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

  findImplementors(nodeId: number): RelatedNodeRow[] {
    const results: RelatedNodeRow[] = [];
    for (const e of this.#edges.values()) {
      if (e.target_id === nodeId && e.kind === 'implements') {
        const n = this.#nodes.get(e.source_id);
        if (n) results.push({ id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line });
      }
    }
    return results;
  }

  findInterfaces(nodeId: number): RelatedNodeRow[] {
    const results: RelatedNodeRow[] = [];
    for (const e of this.#edges.values()) {
      if (e.source_id === nodeId && e.kind === 'implements') {
        const n = this.#nodes.get(e.target_id);
        if (n) results.push({ id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line });
      }
    }
    return results;
  }

  findIntraFileCallEdges(file: string): IntraFileCallEdge[] {
    const results: IntraFileCallEdge[] = [];
    for (const e of this.#edges.values()) {
      if (e.kind !== 'calls') continue;
      const caller = this.#nodes.get(e.source_id);
      const callee = this.#nodes.get(e.target_id);
      if (caller && callee && caller.file === file && callee.file === file) {
        results.push({ caller_name: caller.name, callee_name: callee.name });
      }
    }
    const lineByName = new Map<string, number>();
    for (const n of this.#nodes.values()) {
      if (n.file === file) lineByName.set(n.name, n.line);
    }
    return results.sort((a, b) => {
      return (lineByName.get(a.caller_name) ?? 0) - (lineByName.get(b.caller_name) ?? 0);
    });
  }

  // ── Graph-read queries ────────────────────────────────────────────

  getCallableNodes(): CallableNodeRow[] {
    return [...this.#nodes.values()]
      .filter((n) => (CORE_SYMBOL_KINDS as readonly string[]).includes(n.kind))
      .map((n) => ({ id: n.id, name: n.name, kind: n.kind, file: n.file }));
  }

  getCallEdges(): CallEdgeRow[] {
    return [...this.#edges.values()]
      .filter((e) => e.kind === 'calls')
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id, confidence: e.confidence }));
  }

  getFileNodesAll(): FileNodeRow[] {
    return [...this.#nodes.values()]
      .filter((n) => n.kind === 'file')
      .map((n) => ({ id: n.id, name: n.name, file: n.file }));
  }

  getImportEdges(): ImportGraphEdgeRow[] {
    return [...this.#edges.values()]
      .filter((e) => e.kind === 'imports' || e.kind === 'imports-type')
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id }));
  }

  // ── Optional table checks ─────────────────────────────────────────

  hasCfgTables(): boolean {
    return false;
  }

  hasEmbeddings(): boolean {
    return false;
  }

  hasDataflowTable(): boolean {
    return false;
  }

  getComplexityForNode(nodeId: number): ComplexityMetrics | undefined {
    return this.#complexity.get(nodeId);
  }

  // ── Private helpers ───────────────────────────────────────────────

  /** Compute fan-in (incoming 'calls' edge count) for all nodes. */
  #computeFanIn(): Map<number, number> {
    const fanIn = new Map<number, number>();
    for (const e of this.#edges.values()) {
      if (e.kind === 'calls') {
        fanIn.set(e.target_id, (fanIn.get(e.target_id) ?? 0) + 1);
      }
    }
    return fanIn;
  }

  /** Internal generator for function/method/class listing with filters. */
  *#iterateFunctionNodesImpl(opts: ListFunctionOpts = {}): IterableIterator<NodeRow> {
    let nodes = [...this.#nodes.values()].filter((n) =>
      ['function', 'method', 'class'].includes(n.kind),
    );

    {
      const fileFn = buildFileFilterFn(opts.file);
      if (fileFn) nodes = nodes.filter((n) => fileFn(n.file));
    }
    if (opts.pattern) {
      const patternRe = likeToRegex(`%${escapeLike(opts.pattern)}%`);
      nodes = nodes.filter((n) => patternRe.test(n.name));
    }
    if (opts.noTests) {
      nodes = nodes.filter(
        (n) =>
          !n.file.includes('.test.') &&
          !n.file.includes('.spec.') &&
          !n.file.includes('__test__') &&
          !n.file.includes('__tests__') &&
          !n.file.includes('.stories.'),
      );
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
      } as NodeRow;
    }
  }
}
