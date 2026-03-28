/**
 * NativeRepository — delegates all Repository read methods to NativeDatabase (rusqlite via napi-rs).
 *
 * Phase 6.14: every query runs via rusqlite when the native engine is available.
 * Falls back to SqliteRepository (better-sqlite3) when native is unavailable.
 *
 * napi-rs converts Rust snake_case fields to JS camelCase. This class maps them
 * back to the snake_case field names that the Repository interface expects.
 */

import { ConfigError } from '../../shared/errors.js';
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
  ListFunctionOpts,
  NativeAdjacentEdgeRow,
  NativeCallableNodeRow,
  NativeCallEdgeRow,
  NativeChildNodeRow,
  NativeComplexityMetrics,
  NativeDatabase,
  NativeFileNodeRow,
  NativeImportEdgeRow,
  NativeImportGraphEdgeRow,
  NativeIntraFileCallEdge,
  NativeNodeIdRow,
  NativeNodeRow,
  NativeNodeRowWithFanIn,
  NativeRelatedNodeRow,
  NativeTriageNodeRow,
  NodeIdRow,
  NodeRow,
  NodeRowWithFanIn,
  QueryOpts,
  RelatedNodeRow,
  TriageNodeRow,
  TriageQueryOpts,
} from '../../types.js';
import { Repository } from './base.js';

// ── Row converters (napi camelCase → Repository snake_case) ─────────────

function toNodeRow(r: NativeNodeRow): NodeRow {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as NodeRow['kind'],
    file: r.file,
    line: r.line ?? 0,
    end_line: r.endLine ?? null,
    parent_id: r.parentId ?? null,
    exported: (r.exported ?? null) as 0 | 1 | null,
    qualified_name: r.qualifiedName ?? null,
    scope: r.scope ?? null,
    visibility: (r.visibility ?? null) as NodeRow['visibility'],
    role: (r.role ?? null) as NodeRow['role'],
  };
}

function toNodeRowWithFanIn(r: NativeNodeRowWithFanIn): NodeRowWithFanIn {
  return { ...toNodeRow(r), fan_in: r.fanIn };
}

function toTriageNodeRow(r: NativeTriageNodeRow): TriageNodeRow {
  return {
    ...toNodeRow(r),
    fan_in: r.fanIn,
    cognitive: r.cognitive,
    mi: r.mi,
    cyclomatic: r.cyclomatic,
    max_nesting: r.maxNesting,
    churn: r.churn,
  };
}

function toNodeIdRow(r: NativeNodeIdRow): NodeIdRow {
  return { id: r.id, name: r.name, kind: r.kind, line: r.line };
}

function toChildNodeRow(r: NativeChildNodeRow): ChildNodeRow {
  return {
    name: r.name,
    kind: r.kind as ChildNodeRow['kind'],
    line: r.line ?? 0,
    end_line: r.endLine ?? null,
    qualified_name: r.qualifiedName ?? null,
    scope: r.scope ?? null,
    visibility: (r.visibility ?? null) as ChildNodeRow['visibility'],
  };
}

function toRelatedNodeRow(r: NativeRelatedNodeRow): RelatedNodeRow {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    file: r.file,
    line: r.line,
    end_line: r.endLine,
  };
}

function toAdjacentEdgeRow(r: NativeAdjacentEdgeRow): AdjacentEdgeRow {
  return {
    name: r.name,
    kind: r.kind,
    file: r.file,
    line: r.line,
    edge_kind: r.edgeKind as AdjacentEdgeRow['edge_kind'],
  };
}

function toImportEdgeRow(r: NativeImportEdgeRow): ImportEdgeRow {
  return { file: r.file, edge_kind: r.edgeKind as ImportEdgeRow['edge_kind'] };
}

function toIntraFileCallEdge(r: NativeIntraFileCallEdge): IntraFileCallEdge {
  return { caller_name: r.callerName, callee_name: r.calleeName };
}

function toCallableNodeRow(r: NativeCallableNodeRow): CallableNodeRow {
  return { id: r.id, name: r.name, kind: r.kind, file: r.file };
}

function toCallEdgeRow(r: NativeCallEdgeRow): CallEdgeRow {
  return {
    source_id: r.sourceId,
    target_id: r.targetId,
    confidence: r.confidence,
  };
}

function toFileNodeRow(r: NativeFileNodeRow): FileNodeRow {
  return { id: r.id, name: r.name, file: r.file };
}

function toImportGraphEdgeRow(r: NativeImportGraphEdgeRow): ImportGraphEdgeRow {
  return { source_id: r.sourceId, target_id: r.targetId };
}

function toComplexityMetrics(r: NativeComplexityMetrics): ComplexityMetrics {
  return {
    cognitive: r.cognitive,
    cyclomatic: r.cyclomatic,
    max_nesting: r.maxNesting,
    maintainability_index: r.maintainabilityIndex ?? null,
    halstead_volume: r.halsteadVolume ?? null,
  };
}

// ── NativeRepository ────────────────────────────────────────────────────

export class NativeRepository extends Repository {
  #ndb: NativeDatabase;

  constructor(ndb: NativeDatabase) {
    super();
    this.#ndb = ndb;
  }

  // ── Node lookups ──────────────────────────────────────────────────

  findNodeById(id: number): NodeRow | undefined {
    const r = this.#ndb.findNodeById(id);
    return r ? toNodeRow(r) : undefined;
  }

  findNodesByFile(file: string): NodeRow[] {
    return this.#ndb.findNodesByFile(file).map(toNodeRow);
  }

  findFileNodes(fileLike: string): NodeRow[] {
    return this.#ndb.findFileNodes(fileLike).map(toNodeRow);
  }

  findNodesWithFanIn(namePattern: string, opts: QueryOpts = {}): NodeRowWithFanIn[] {
    return this.#ndb
      .findNodesWithFanIn(namePattern, opts.kinds ?? null, opts.file ?? null)
      .map(toNodeRowWithFanIn);
  }

  countNodes(): number {
    return this.#ndb.countNodes();
  }

  countEdges(): number {
    return this.#ndb.countEdges();
  }

  countFiles(): number {
    return this.#ndb.countFiles();
  }

  getNodeId(name: string, kind: string, file: string, line: number): number | undefined {
    return this.#ndb.getNodeId(name, kind, file, line) ?? undefined;
  }

  getFunctionNodeId(name: string, file: string, line: number): number | undefined {
    return this.#ndb.getFunctionNodeId(name, file, line) ?? undefined;
  }

  bulkNodeIdsByFile(file: string): NodeIdRow[] {
    return this.#ndb.bulkNodeIdsByFile(file).map(toNodeIdRow);
  }

  findNodeChildren(parentId: number): ChildNodeRow[] {
    return this.#ndb.findNodeChildren(parentId).map(toChildNodeRow);
  }

  findNodesByScope(scopeName: string, opts: QueryOpts = {}): NodeRow[] {
    return this.#ndb
      .findNodesByScope(scopeName, opts.kind ?? null, opts.file ?? null)
      .map(toNodeRow);
  }

  findNodeByQualifiedName(qualifiedName: string, opts: { file?: string } = {}): NodeRow[] {
    return this.#ndb.findNodeByQualifiedName(qualifiedName, opts.file ?? null).map(toNodeRow);
  }

  listFunctionNodes(opts: ListFunctionOpts = {}): NodeRow[] {
    return this.#ndb
      .listFunctionNodes(opts.file ?? null, opts.pattern ?? null, opts.noTests ?? null)
      .map(toNodeRow);
  }

  iterateFunctionNodes(opts: ListFunctionOpts = {}): IterableIterator<NodeRow> {
    const rows = this.#ndb
      .iterateFunctionNodes(opts.file ?? null, opts.pattern ?? null, opts.noTests ?? null)
      .map(toNodeRow);
    return rows[Symbol.iterator]();
  }

  findNodesForTriage(opts: TriageQueryOpts = {}): TriageNodeRow[] {
    try {
      return this.#ndb
        .findNodesForTriage(
          opts.kind ?? null,
          opts.role ?? null,
          opts.file ?? null,
          opts.noTests ?? null,
        )
        .map(toTriageNodeRow);
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg.startsWith('Invalid kind:') || msg.startsWith('Invalid role:')) {
        throw new ConfigError(msg);
      }
      throw e;
    }
  }

  // ── Edge queries ──────────────────────────────────────────────────

  findCallees(nodeId: number): RelatedNodeRow[] {
    return this.#ndb.findCallees(nodeId).map(toRelatedNodeRow);
  }

  findCallers(nodeId: number): RelatedNodeRow[] {
    return this.#ndb.findCallers(nodeId).map(toRelatedNodeRow);
  }

  findDistinctCallers(nodeId: number): RelatedNodeRow[] {
    return this.#ndb.findDistinctCallers(nodeId).map(toRelatedNodeRow);
  }

  findAllOutgoingEdges(nodeId: number): AdjacentEdgeRow[] {
    return this.#ndb.findAllOutgoingEdges(nodeId).map(toAdjacentEdgeRow);
  }

  findAllIncomingEdges(nodeId: number): AdjacentEdgeRow[] {
    return this.#ndb.findAllIncomingEdges(nodeId).map(toAdjacentEdgeRow);
  }

  findCalleeNames(nodeId: number): string[] {
    return this.#ndb.findCalleeNames(nodeId);
  }

  findCallerNames(nodeId: number): string[] {
    return this.#ndb.findCallerNames(nodeId);
  }

  findImportTargets(nodeId: number): ImportEdgeRow[] {
    return this.#ndb.findImportTargets(nodeId).map(toImportEdgeRow);
  }

  findImportSources(nodeId: number): ImportEdgeRow[] {
    return this.#ndb.findImportSources(nodeId).map(toImportEdgeRow);
  }

  findImportDependents(nodeId: number): NodeRow[] {
    return this.#ndb.findImportDependents(nodeId).map(toNodeRow);
  }

  findCrossFileCallTargets(file: string): Set<number> {
    return new Set(this.#ndb.findCrossFileCallTargets(file));
  }

  countCrossFileCallers(nodeId: number, file: string): number {
    return this.#ndb.countCrossFileCallers(nodeId, file);
  }

  getClassHierarchy(classNodeId: number): Set<number> {
    return new Set(this.#ndb.getClassHierarchy(classNodeId));
  }

  findImplementors(nodeId: number): RelatedNodeRow[] {
    return this.#ndb.findImplementors(nodeId).map(toRelatedNodeRow);
  }

  findInterfaces(nodeId: number): RelatedNodeRow[] {
    return this.#ndb.findInterfaces(nodeId).map(toRelatedNodeRow);
  }

  findIntraFileCallEdges(file: string): IntraFileCallEdge[] {
    return this.#ndb.findIntraFileCallEdges(file).map(toIntraFileCallEdge);
  }

  // ── Graph-read queries ────────────────────────────────────────────

  getCallableNodes(): CallableNodeRow[] {
    return this.#ndb.getCallableNodes().map(toCallableNodeRow);
  }

  getCallEdges(): CallEdgeRow[] {
    return this.#ndb.getCallEdges().map(toCallEdgeRow);
  }

  getFileNodesAll(): FileNodeRow[] {
    return this.#ndb.getFileNodesAll().map(toFileNodeRow);
  }

  getImportEdges(): ImportGraphEdgeRow[] {
    return this.#ndb.getImportEdges().map(toImportGraphEdgeRow);
  }

  // ── Optional table checks ─────────────────────────────────────────

  hasCfgTables(): boolean {
    return this.#ndb.hasCfgTables();
  }

  hasEmbeddings(): boolean {
    return this.#ndb.hasEmbeddings();
  }

  hasDataflowTable(): boolean {
    return this.#ndb.hasDataflowTable();
  }

  getComplexityForNode(nodeId: number): ComplexityMetrics | undefined {
    const r = this.#ndb.getComplexityForNode(nodeId);
    return r ? toComplexityMetrics(r) : undefined;
  }
}
