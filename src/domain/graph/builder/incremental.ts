/**
 * Incremental single-file rebuild — used by watch mode.
 *
 * Reuses pipeline helpers instead of duplicating node insertion and edge building
 * logic from the main builder. This eliminates the watcher.js divergence (ROADMAP 3.9).
 *
 * Reverse-dep cascade: when a file changes, files that have edges targeting it
 * must have their outgoing edges rebuilt (since the changed file's node IDs change).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bulkNodeIdsByFile, purgeFileData } from '../../../db/index.js';
import { debug, warn } from '../../../infrastructure/logger.js';
import { normalizePath } from '../../../shared/constants.js';
import type {
  BetterSqlite3Database,
  EngineOpts,
  ExtractorOutput,
  PathAliases,
  SqliteStatement,
} from '../../../types.js';
import { parseFileIncremental } from '../../parser.js';
import { computeConfidence, resolveImportPath } from '../resolve.js';
import {
  type CallNodeLookup,
  findCaller,
  resolveCallTargets,
  resolveReceiverEdge,
  resolveSameClassQualifiedMethod,
} from './call-resolver.js';
import { BUILTIN_RECEIVERS, fileHash, fileStat, readFileSafe } from './helpers.js';
import { importNamePairs } from './import-utils.js';

// ── Local types ─────────────────────────────────────────────────────────

export interface IncrementalStmts {
  insertNode: { run: (...params: unknown[]) => unknown };
  insertEdge: { run: (...params: unknown[]) => unknown };
  getNodeId: { get: (...params: unknown[]) => { id: number } | undefined };
  countNodes: { get: (...params: unknown[]) => { c: number } | undefined };
  countEdges: { get: (...params: unknown[]) => { c: number } | undefined };
  listSymbols: { all: (...params: unknown[]) => unknown[] };
  findNodeInFile: { all: (...params: unknown[]) => unknown[] };
  findNodeByName: { all: (...params: unknown[]) => unknown[] };
  /**
   * Upsert a `file_hashes` row: `(relPath, hash, mtime, size)`. Called only
   * after a file's edges have been fully rebuilt (#1731) — see the call site
   * in `rebuildFile` for why this can't happen any earlier.
   */
  upsertFileHash: { run: (...params: unknown[]) => unknown };
  /** Delete a `file_hashes` row for a file removed from disk. */
  deleteFileHash: { run: (...params: unknown[]) => unknown };
}

interface RebuildResult {
  file: string;
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesBefore: number;
  deleted?: boolean;
  event?: string;
  symbolDiff?: unknown;
  nodesBefore?: number;
  nodesAfter?: number;
}

// ── Node insertion ──────────────────────────────────────────────────────

function insertFileNodes(stmts: IncrementalStmts, relPath: string, symbols: ExtractorOutput): void {
  stmts.insertNode.run(relPath, 'file', relPath, 0, null);
  for (const def of symbols.definitions) {
    stmts.insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
    if (def.children?.length) {
      for (const child of def.children) {
        stmts.insertNode.run(child.name, child.kind, relPath, child.line, child.endLine || null);
      }
    }
  }
  for (const exp of symbols.exports) {
    stmts.insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
  }
}

// ── Containment edges ──────────────────────────────────────────────────

function buildContainmentEdges(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  relPath: string,
  symbols: ExtractorOutput,
): number {
  const nodeIdMap = new Map<string, number>();
  for (const row of bulkNodeIdsByFile(db, relPath)) {
    nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
  }
  const fileId = nodeIdMap.get(`${relPath}|file|0`);
  let edgesAdded = 0;
  for (const def of symbols.definitions) {
    const defId = nodeIdMap.get(`${def.name}|${def.kind}|${def.line}`);
    if (fileId && defId) {
      stmts.insertEdge.run(fileId, defId, 'contains', 1.0, 0);
      edgesAdded++;
    }
    if (def.children?.length && defId) {
      for (const child of def.children) {
        const childId = nodeIdMap.get(`${child.name}|${child.kind}|${child.line}`);
        if (childId) {
          stmts.insertEdge.run(defId, childId, 'contains', 1.0, 0);
          edgesAdded++;
          if (child.kind === 'parameter') {
            stmts.insertEdge.run(childId, defId, 'parameter_of', 1.0, 0);
            edgesAdded++;
          }
        }
      }
    }
  }
  return edgesAdded;
}

// ── Reverse-dep cascade ────────────────────────────────────────────────

// Lazily-cached prepared statements for reverse-dep operations
let _revDepDb: BetterSqlite3Database | null = null;
let _findRevDepsStmt: SqliteStatement | null = null;
let _deleteDataflowByCallEdgeStmt: SqliteStatement | null | undefined; // undefined = not yet tried
let _deleteOutEdgesStmt: SqliteStatement | null = null;

function getRevDepStmts(db: BetterSqlite3Database): {
  findRevDepsStmt: SqliteStatement;
  deleteDataflowByCallEdgeStmt: SqliteStatement | null;
  deleteOutEdgesStmt: SqliteStatement;
} {
  if (_revDepDb !== db) {
    _revDepDb = db;
    _findRevDepsStmt = db.prepare(
      `SELECT DISTINCT n_src.file FROM edges e
       JOIN nodes n_src ON e.source_id = n_src.id
       JOIN nodes n_tgt ON e.target_id = n_tgt.id
       WHERE n_tgt.file = ? AND n_src.file != ? AND n_src.kind != 'directory'`,
    );
    // Delete inter-procedural dataflow rows whose call_edge_id references an
    // outgoing edge from this file. Must run before deleteOutEdgesStmt to avoid
    // SQLITE_CONSTRAINT_FOREIGNKEY: dataflow.call_edge_id REFERENCES edges(id).
    try {
      _deleteDataflowByCallEdgeStmt = db.prepare(
        `DELETE FROM dataflow WHERE call_edge_id IN
           (SELECT id FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?))`,
      );
    } catch {
      _deleteDataflowByCallEdgeStmt = null; // dataflow table or call_edge_id column absent
    }
    _deleteOutEdgesStmt = db.prepare(
      'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    );
  }
  return {
    findRevDepsStmt: _findRevDepsStmt!,
    deleteDataflowByCallEdgeStmt: _deleteDataflowByCallEdgeStmt ?? null,
    deleteOutEdgesStmt: _deleteOutEdgesStmt!,
  };
}

function findReverseDeps(db: BetterSqlite3Database, relPath: string): string[] {
  const { findRevDepsStmt } = getRevDepStmts(db);
  return (findRevDepsStmt.all(relPath, relPath) as Array<{ file: string }>).map((r) => r.file);
}

function deleteOutgoingEdges(db: BetterSqlite3Database, relPath: string): void {
  const { deleteDataflowByCallEdgeStmt, deleteOutEdgesStmt } = getRevDepStmts(db);
  // Clear any inter-procedural dataflow rows that reference outgoing edges via
  // call_edge_id before deleting those edges (FK: dataflow.call_edge_id → edges.id).
  deleteDataflowByCallEdgeStmt?.run(relPath);
  deleteOutEdgesStmt.run(relPath);
}

async function parseReverseDep(
  rootDir: string,
  depRelPath: string,
  engineOpts: EngineOpts,
  cache: unknown,
): Promise<ExtractorOutput | null> {
  const absPath = path.join(rootDir, depRelPath);
  if (!fs.existsSync(absPath)) return null;

  let code: string;
  try {
    code = readFileSafe(absPath);
  } catch (e: unknown) {
    debug(`parseReverseDep: cannot read ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  return parseFileIncremental(cache, absPath, code, engineOpts);
}

function rebuildReverseDepEdges(
  db: BetterSqlite3Database,
  rootDir: string,
  depRelPath: string,
  symbols: ExtractorOutput,
  stmts: IncrementalStmts,
  skipBarrel: boolean,
): number {
  const fileNodeRow = stmts.getNodeId.get(depRelPath, 'file', depRelPath, 0);
  if (!fileNodeRow) return 0;

  const aliases: PathAliases = { baseUrl: null, paths: {} };
  let edgesAdded = buildContainmentEdges(db, stmts, depRelPath, symbols);
  // Don't rebuild dir->file containment for reverse-deps (it was never deleted)
  edgesAdded += buildImportEdges(
    stmts,
    depRelPath,
    symbols,
    rootDir,
    fileNodeRow.id,
    aliases,
    skipBarrel ? null : db,
  );
  const { importedNames, importedOriginalNames } = buildImportedNamesMap(
    symbols,
    rootDir,
    depRelPath,
    aliases,
    db,
  );
  edgesAdded += buildCallEdges(
    db,
    stmts,
    depRelPath,
    symbols,
    fileNodeRow,
    importedNames,
    importedOriginalNames,
  );
  edgesAdded += buildClassHierarchyEdges(stmts, depRelPath, symbols);
  return edgesAdded;
}

// ── Directory containment edges ────────────────────────────────────────

function rebuildDirContainment(
  _db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  relPath: string,
): number {
  const dir = normalizePath(path.dirname(relPath));
  if (!dir || dir === '.') return 0;
  const dirRow = stmts.getNodeId.get(dir, 'directory', dir, 0);
  const fileRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (dirRow && fileRow) {
    stmts.insertEdge.run(dirRow.id, fileRow.id, 'contains', 1.0, 0);
    return 1;
  }
  return 0;
}

// ── Import edge building ────────────────────────────────────────────────

// Lazily-cached prepared statements for barrel resolution (avoid re-preparing in hot loops)
let _barrelDb: BetterSqlite3Database | null = null;
let _isBarrelStmt: SqliteStatement | null = null;
let _reexportTargetsStmt: SqliteStatement | null = null;
let _hasDefStmt: SqliteStatement | null = null;

function getBarrelStmts(db: BetterSqlite3Database): {
  isBarrelStmt: SqliteStatement;
  reexportTargetsStmt: SqliteStatement;
  hasDefStmt: SqliteStatement;
} {
  if (_barrelDb !== db) {
    _barrelDb = db;
    _isBarrelStmt = db.prepare(
      `SELECT COUNT(*) as c FROM edges e
       JOIN nodes n ON e.source_id = n.id
       WHERE e.kind = 'reexports' AND n.file = ? AND n.kind = 'file'`,
    );
    _reexportTargetsStmt = db.prepare(
      `SELECT DISTINCT n2.file FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       WHERE e.kind = 'reexports' AND n1.file = ? AND n1.kind = 'file'`,
    );
    _hasDefStmt = db.prepare(
      `SELECT 1 FROM nodes WHERE name = ? AND file = ? AND kind != 'file' AND kind != 'directory' LIMIT 1`,
    );
  }
  return {
    isBarrelStmt: _isBarrelStmt!,
    reexportTargetsStmt: _reexportTargetsStmt!,
    hasDefStmt: _hasDefStmt!,
  };
}

function isBarrelFile(db: BetterSqlite3Database, relPath: string): boolean {
  const { isBarrelStmt } = getBarrelStmts(db);
  const reexportCount = (isBarrelStmt.get(relPath) as { c: number } | undefined)?.c;
  return (reexportCount || 0) > 0;
}

function resolveBarrelTarget(
  db: BetterSqlite3Database,
  barrelPath: string,
  symbolName: string,
  visited: Set<string> = new Set(),
): string | null {
  if (visited.has(barrelPath)) return null;
  visited.add(barrelPath);

  const { reexportTargetsStmt, hasDefStmt } = getBarrelStmts(db);

  // Find re-export targets from this barrel
  const reexportTargets = reexportTargetsStmt.all(barrelPath) as Array<{ file: string }>;

  for (const { file: targetFile } of reexportTargets) {
    // Check if the symbol is defined in this target file
    const hasDef = hasDefStmt.get(symbolName, targetFile);
    if (hasDef) return targetFile;

    // Recurse through barrel chains
    if (isBarrelFile(db, targetFile)) {
      const deeper = resolveBarrelTarget(db, targetFile, symbolName, visited);
      if (deeper) return deeper;
    }
  }
  return null;
}

/**
 * Resolve barrel imports for a single import statement and create edges to actual source files.
 * Shared by buildImportEdges (primary file) and Pass 2 of the reverse-dep cascade.
 */
function resolveBarrelImportEdges(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  fileNodeId: number,
  resolvedPath: string,
  imp: ExtractorOutput['imports'][number],
): number {
  let edgesAdded = 0;
  if (!isBarrelFile(db, resolvedPath)) return edgesAdded;
  const resolvedSources = new Set<string>();
  for (const { original } of importNamePairs(imp)) {
    const actualSource = resolveBarrelTarget(db, resolvedPath, original);
    if (actualSource && actualSource !== resolvedPath && !resolvedSources.has(actualSource)) {
      resolvedSources.add(actualSource);
      const actualRow = stmts.getNodeId.get(actualSource, 'file', actualSource, 0);
      if (actualRow) {
        const kind = imp.typeOnly ? 'imports-type' : 'imports';
        stmts.insertEdge.run(fileNodeId, actualRow.id, kind, 0.9, 0);
        edgesAdded++;
      }
    }
  }
  return edgesAdded;
}

/**
 * Emit one symbol-level edge per named specifier — shared by `import type`
 * statements (`imports-type`, #1724) and named re-exports (`reexports`,
 * #1742). Wildcard re-exports (`export * from 'Y'`) carry no specific names,
 * so the loop is a no-op for them; the query layer falls back to the
 * target's full export list for anything reached only by the file-level
 * edge. Mirrors `emitNamedSymbolEdges` in build-edges.ts (full-build path).
 */
function emitNamedSymbolEdges(
  db: BetterSqlite3Database | null,
  stmts: IncrementalStmts,
  imp: ExtractorOutput['imports'][number],
  resolvedPath: string,
  fileNodeId: number,
  edgeKind: 'imports-type' | 'reexports',
): number {
  let edgesAdded = 0;
  for (const { original } of importNamePairs(imp)) {
    let targetFile = resolvedPath;
    if (db && isBarrelFile(db, resolvedPath)) {
      const actual = resolveBarrelTarget(db, resolvedPath, original);
      if (actual) targetFile = actual;
    }
    const candidates = stmts.findNodeInFile.all(original, targetFile) as Array<{
      id: number;
      file: string;
    }>;
    if (candidates.length === 0) continue;
    stmts.insertEdge.run(fileNodeId, candidates[0]!.id, edgeKind, 1.0, 0);
    edgesAdded++;
  }
  return edgesAdded;
}

/**
 * Process a single import statement: emit the file→file edge, any
 * symbol-level type-only edges, and barrel re-export edges.
 */
function emitEdgesForImport(
  stmts: IncrementalStmts,
  imp: ExtractorOutput['imports'][number],
  fileNodeId: number,
  relPath: string,
  rootDir: string,
  aliases: PathAliases,
  db: BetterSqlite3Database | null,
): number {
  const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
  const targetRow = stmts.getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
  if (!targetRow) return 0;

  const edgeKind = imp.reexport
    ? 'reexports'
    : imp.typeOnly
      ? 'imports-type'
      : imp.dynamicImport
        ? 'dynamic-imports'
        : 'imports';
  stmts.insertEdge.run(fileNodeId, targetRow.id, edgeKind, 1.0, 0);
  let edgesAdded = 1;

  if (imp.typeOnly) {
    edgesAdded += emitNamedSymbolEdges(db, stmts, imp, resolvedPath, fileNodeId, 'imports-type');
  }
  if (imp.reexport && !imp.wildcardReexport) {
    edgesAdded += emitNamedSymbolEdges(db, stmts, imp, resolvedPath, fileNodeId, 'reexports');
  } else if (imp.reexport && imp.wildcardReexport) {
    // Mirrors build-edges.ts (full-build path): a genuine wildcard must stay
    // distinguishable from a named reexport even when a *different*
    // statement in this file names specific symbols from the same target
    // (#1849 review). See `collectReexportedSymbols` in
    // domain/analysis/exports.ts.
    stmts.insertEdge.run(fileNodeId, targetRow.id, 'reexports-wildcard', 1.0, 0);
    edgesAdded++;
  }
  if (!imp.reexport && db) {
    edgesAdded += resolveBarrelImportEdges(db, stmts, fileNodeId, resolvedPath, imp);
  }
  return edgesAdded;
}

function buildImportEdges(
  stmts: IncrementalStmts,
  relPath: string,
  symbols: ExtractorOutput,
  rootDir: string,
  fileNodeId: number,
  aliases: PathAliases,
  db: BetterSqlite3Database | null,
): number {
  let edgesAdded = 0;
  for (const imp of symbols.imports) {
    edgesAdded += emitEdgesForImport(stmts, imp, fileNodeId, relPath, rootDir, aliases, db);
  }
  return edgesAdded;
}

/**
 * Mirrors the full-build `buildImportedNamesMap` in build-edges.ts: maps each
 * locally-bound import name to its defining file (`importedNames`), plus, for
 * renamed specifiers (`import { X as Y }`), the *original* exported name
 * (`importedOriginalNames`, keyed by local name Y). Barrel tracing and the
 * downstream target-file symbol lookup must use the original name — the
 * renamed local alias only exists in the importing file (#1730).
 */
function buildImportedNamesMap(
  symbols: ExtractorOutput,
  rootDir: string,
  relPath: string,
  aliases: PathAliases,
  db: BetterSqlite3Database,
): { importedNames: Map<string, string>; importedOriginalNames: Map<string, string> } {
  const importedNames = new Map<string, string>();
  const importedOriginalNames = new Map<string, string>();
  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportPath(
      path.join(rootDir, relPath),
      imp.source,
      rootDir,
      aliases,
    );
    for (const { local, original } of importNamePairs(imp)) {
      // Mirror full-build's `buildImportedNamesMap`: follow barrel re-exports so
      // `importedNames` maps to the *defining* file, not the barrel. This ensures
      // `computeConfidence` gets `importedFrom === targetFile` and returns 1.0
      // instead of the cross-directory fallback (0.3).
      let targetFile = resolvedPath;
      if (isBarrelFile(db, resolvedPath)) {
        const actual = resolveBarrelTarget(db, resolvedPath, original);
        if (actual) targetFile = actual;
      }
      importedNames.set(local, targetFile);
      if (original !== local) importedOriginalNames.set(local, original);
    }
  }
  return { importedNames, importedOriginalNames };
}

// ── Class hierarchy edges ───────────────────────────────────────────────

type NodeWithKind = { id: number; kind: string; file: string };

const HIERARCHY_SOURCE_KINDS = new Set(['class', 'struct', 'record', 'enum']);
const EXTENDS_TARGET_KINDS = new Set(['class', 'struct', 'trait', 'record']);
const IMPLEMENTS_TARGET_KINDS = new Set(['interface', 'trait', 'class']);

function buildClassHierarchyEdges(
  stmts: IncrementalStmts,
  relPath: string,
  symbols: ExtractorOutput,
): number {
  let edgesAdded = 0;
  for (const cls of symbols.classes) {
    const sourceRow = (stmts.findNodeInFile.all(cls.name, relPath) as NodeWithKind[]).find((n) =>
      HIERARCHY_SOURCE_KINDS.has(n.kind),
    );
    if (!sourceRow) continue;

    if (cls.extends) {
      for (const t of (stmts.findNodeByName.all(cls.extends) as NodeWithKind[]).filter((n) =>
        EXTENDS_TARGET_KINDS.has(n.kind),
      )) {
        stmts.insertEdge.run(sourceRow.id, t.id, 'extends', 1.0, 0);
        edgesAdded++;
      }
    }
    if (cls.implements) {
      for (const t of (stmts.findNodeByName.all(cls.implements) as NodeWithKind[]).filter((n) =>
        IMPLEMENTS_TARGET_KINDS.has(n.kind),
      )) {
        stmts.insertEdge.run(sourceRow.id, t.id, 'implements', 1.0, 0);
        edgesAdded++;
      }
    }
  }
  return edgesAdded;
}

// ── Call edge building ──────────────────────────────────────────────────

function makeIncrementalLookup(db: BetterSqlite3Database, stmts: IncrementalStmts): CallNodeLookup {
  return {
    byNameAndFile: (name, file) =>
      stmts.findNodeInFile.all(name, file) as Array<{ id: number; file: string; kind?: string }>,
    byName: (name) =>
      stmts.findNodeByName.all(name) as Array<{ id: number; file: string; kind?: string }>,
    isBarrel: (file) => isBarrelFile(db, file),
    resolveBarrel: (barrelFile, symbolName) => resolveBarrelTarget(db, barrelFile, symbolName),
    nodeId: (name, kind, file, line) =>
      stmts.getNodeId.get(name, kind, file, line) as { id: number } | undefined,
  };
}

/** Coerce symbols.typeMap (Map, Array, or undefined) to a canonical Map. */
function coerceTypeMap(symbols: ExtractorOutput): Map<string, unknown> {
  const rawTM: unknown = symbols.typeMap;
  if (rawTM instanceof Map) return rawTM;
  if (Array.isArray(rawTM) && rawTM.length > 0) {
    return new Map(
      (rawTM as Array<{ name: string; typeName?: string; type?: string }>).map((e) => [
        e.name,
        e.typeName ?? e.type ?? null,
      ]),
    );
  }
  return new Map();
}

/**
 * Seed scoped rest-param keys into typeMap (Phase 8.3f).
 * Mirrors buildObjectRestParamPostPass in the full build.
 *
 * Scoped keys (`callee::restName`) prevent same-name rest-param collisions
 * when two functions in the same file both use `...rest` (#1358). The
 * unscoped key is also seeded when only one callee uses a given rest name,
 * preserving resolution when callerName is null.
 */
function seedRestParamTypeMap(typeMap: Map<string, unknown>, symbols: ExtractorOutput): void {
  if (!symbols.objectRestParamBindings?.length || !symbols.paramBindings?.length) return;

  const restNameCallees = new Map<string, Set<string>>();
  for (const orpb of symbols.objectRestParamBindings) {
    if (!restNameCallees.has(orpb.restName)) restNameCallees.set(orpb.restName, new Set());
    restNameCallees.get(orpb.restName)!.add(orpb.callee);
  }
  for (const orpb of symbols.objectRestParamBindings) {
    for (const pb of symbols.paramBindings) {
      if (pb.callee === orpb.callee && pb.argIndex === orpb.argIndex) {
        const scopedKey = `${orpb.callee}::${orpb.restName}`;
        if (!typeMap.has(scopedKey)) {
          typeMap.set(scopedKey, { type: pb.argName, confidence: 0.65 });
          if (restNameCallees.get(orpb.restName)!.size === 1 && !typeMap.has(orpb.restName)) {
            typeMap.set(orpb.restName, { type: pb.argName, confidence: 0.65 });
          }
        }
      }
    }
  }
}

/**
 * Normalize symbols.typeMap into a canonical Map and seed scoped rest-param
 * keys (Phase 8.3f). Mirrors buildObjectRestParamPostPass in the full build.
 */
function buildIncrementalTypeMap(symbols: ExtractorOutput): Map<string, unknown> {
  const typeMap = coerceTypeMap(symbols);
  seedRestParamTypeMap(typeMap, symbols);
  return typeMap;
}

/**
 * Strategy 2 — Object.defineProperty accessor fallback.
 * When a function is registered as a getter/setter via
 * `Object.defineProperty(obj, "bar", { get: getter })`, calls to `this.X()`
 * inside `getter` resolve against `obj`. Looks up the receiver var in the
 * typeMap for its type, then falls back to any same-file definition named
 * `callName` with function or method kind.
 */
function resolveDefinePropertyTarget(
  callName: string,
  callerName: string,
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
  definePropertyReceivers: Map<string, string>,
): Array<{ id: number; file: string; kind?: string }> {
  const receiverVarName = definePropertyReceivers.get(callerName);
  if (!receiverVarName) return [];

  const typeEntry = typeMap.get(receiverVarName);
  const typeName = typeEntry
    ? typeof typeEntry === 'string'
      ? typeEntry
      : (typeEntry as { type?: string }).type
    : null;
  if (typeName) {
    const qualified = lookup.byNameAndFile(`${typeName}.${callName}`, relPath);
    if (qualified.length > 0) return [...qualified];
  }
  // Narrow to function/method kinds only to avoid matching unrelated
  // variables or classes that share a name in the same file.
  return lookup
    .byNameAndFile(callName, relPath)
    .filter((n) => n.kind === 'function' || n.kind === 'method');
}

/**
 * Apply `this`-receiver fallback resolution strategies for a single call site
 * when the primary resolveCallTargets pass returned no targets.
 */
function applyThisReceiverFallbacks(
  call: { name: string; receiver?: string | null },
  callerName: string | null,
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
  definePropertyReceivers: Map<string, string> | undefined,
  initialTargets: Array<{ id: number; file: string; kind?: string }>,
): Array<{ id: number; file: string; kind?: string }> {
  if (initialTargets.length > 0) return initialTargets;

  // Strategy 1: same-class `this.method()` fallback.
  if (call.receiver === 'this' && callerName != null) {
    const s1 = resolveSameClassQualifiedMethod(call.name, callerName, relPath, lookup);
    if (s1.length > 0) return s1;
  }

  // Strategy 2: Object.defineProperty accessor fallback.
  if (call.receiver === 'this' && callerName != null && definePropertyReceivers) {
    return resolveDefinePropertyTarget(
      call.name,
      callerName,
      relPath,
      typeMap,
      lookup,
      definePropertyReceivers,
    );
  }

  return initialTargets;
}

/**
 * Emit direct `calls` edges for the resolved targets of a single call site,
 * then emit a `receiver` edge when the call has a non-this/self/super receiver.
 * Returns the number of edges inserted.
 */
function emitIncrementalCallEdges(
  call: { name: string; receiver?: string | null; dynamic?: boolean },
  caller: { id: number; callerName: string | null },
  targets: Array<{ id: number; file: string; kind?: string }>,
  importedFrom: string | null | undefined,
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
  importedNames: Map<string, string>,
  seenCallEdges: Set<string>,
  stmts: IncrementalStmts,
): number {
  let edgesAdded = 0;

  for (const t of targets) {
    const edgeKey = `${caller.id}|${t.id}`;
    if (t.id !== caller.id && !seenCallEdges.has(edgeKey)) {
      seenCallEdges.add(edgeKey);
      const confidence = computeConfidence(relPath, t.file, importedFrom ?? null);
      stmts.insertEdge.run(caller.id, t.id, 'calls', confidence, call.dynamic ? 1 : 0);
      edgesAdded++;
    }
  }

  if (
    call.receiver &&
    !BUILTIN_RECEIVERS.has(call.receiver) &&
    call.receiver !== 'this' &&
    call.receiver !== 'self' &&
    call.receiver !== 'super'
  ) {
    const recv = resolveReceiverEdge(
      lookup,
      { name: call.name, receiver: call.receiver },
      caller,
      relPath,
      typeMap,
      seenCallEdges,
      importedNames,
    );
    if (recv) {
      stmts.insertEdge.run(recv.callerId, recv.receiverId, 'receiver', recv.confidence, 0);
      edgesAdded++;
    }
  }

  return edgesAdded;
}

function buildCallEdges(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  relPath: string,
  symbols: ExtractorOutput,
  fileNodeRow: { id: number },
  importedNames: Map<string, string>,
  importedOriginalNames?: ReadonlyMap<string, string>,
): number {
  const typeMap = buildIncrementalTypeMap(symbols);
  const seenCallEdges = new Set<string>();
  const lookup = makeIncrementalLookup(db, stmts);
  let edgesAdded = 0;

  for (const call of symbols.calls) {
    if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;

    const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
    const { targets: initialTargets, importedFrom } = resolveCallTargets(
      lookup,
      call,
      relPath,
      importedNames,
      typeMap,
      caller.callerName,
      importedOriginalNames,
    );

    const targets = applyThisReceiverFallbacks(
      call,
      caller.callerName,
      relPath,
      typeMap,
      lookup,
      symbols.definePropertyReceivers,
      initialTargets,
    );

    edgesAdded += emitIncrementalCallEdges(
      call,
      caller,
      targets,
      importedFrom,
      relPath,
      typeMap,
      lookup,
      importedNames,
      seenCallEdges,
      stmts,
    );
  }
  return edgesAdded;
}

// ── Main entry point ────────────────────────────────────────────────────

/** Build the "this file was deleted" result returned by `rebuildFile`. */
function buildDeletionResult(
  relPath: string,
  oldNodes: number,
  edgesBefore: number,
  oldSymbols: unknown[],
  diffSymbols: ((old: unknown[], new_: unknown[]) => unknown) | undefined,
): RebuildResult {
  const symbolDiff = diffSymbols ? diffSymbols(oldSymbols, []) : null;
  return {
    file: relPath,
    nodesAdded: 0,
    nodesRemoved: oldNodes,
    edgesAdded: 0,
    edgesBefore,
    deleted: true,
    event: 'deleted',
    symbolDiff,
    nodesBefore: oldNodes,
    nodesAfter: 0,
  };
}

/** Rebuild all edges originating in the single (just-parsed) target file. */
function rebuildEdgesForTargetFile(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  relPath: string,
  symbols: ExtractorOutput,
  fileNodeRow: { id: number },
  rootDir: string,
): number {
  const aliases: PathAliases = { baseUrl: null, paths: {} };
  let edgesAdded = buildContainmentEdges(db, stmts, relPath, symbols);
  edgesAdded += rebuildDirContainment(db, stmts, relPath);
  edgesAdded += buildImportEdges(stmts, relPath, symbols, rootDir, fileNodeRow.id, aliases, db);
  const { importedNames, importedOriginalNames } = buildImportedNamesMap(
    symbols,
    rootDir,
    relPath,
    aliases,
    db,
  );
  edgesAdded += buildCallEdges(
    db,
    stmts,
    relPath,
    symbols,
    fileNodeRow,
    importedNames,
    importedOriginalNames,
  );
  edgesAdded += buildClassHierarchyEdges(stmts, relPath, symbols);
  return edgesAdded;
}

/**
 * Re-parse the reverse-deps and delete their outgoing edges so the cascade
 * can rebuild them. Returns the parsed symbols map together with the total
 * edge count across all deps measured *before* deletion — callers add this
 * to their own `edgesBefore` so the net delta stays correct even when the
 * reverse-dep cascade re-inserts edges.
 */
async function parseReverseDeps(
  db: BetterSqlite3Database,
  rootDir: string,
  reverseDeps: string[],
  stmts: IncrementalStmts,
  engineOpts: EngineOpts,
  cache: unknown,
): Promise<{ depSymbols: Map<string, ExtractorOutput>; reverseDepsEdgesBefore: number }> {
  const depSymbols = new Map<string, ExtractorOutput>();
  let reverseDepsEdgesBefore = 0;
  for (const depRelPath of reverseDeps) {
    const symbols_ = await parseReverseDep(rootDir, depRelPath, engineOpts, cache);
    if (symbols_) {
      reverseDepsEdgesBefore += stmts.countEdges.get(depRelPath)?.c ?? 0;
      deleteOutgoingEdges(db, depRelPath);
      depSymbols.set(depRelPath, symbols_);
    }
  }
  return { depSymbols, reverseDepsEdgesBefore };
}

/**
 * Pass 2 of the reverse-dep cascade: now that the changed file's `reexports`
 * edges exist, resolve barrel imports for every reverse-dep so transitive
 * call edges through the barrel still find their targets.
 */
function emitBarrelImportEdgesForReverseDeps(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  depSymbols: Map<string, ExtractorOutput>,
  rootDir: string,
): number {
  let edgesAdded = 0;
  for (const [depRelPath, symbols_] of depSymbols) {
    const fileNodeRow_ = stmts.getNodeId.get(depRelPath, 'file', depRelPath, 0);
    if (!fileNodeRow_) continue;
    const aliases_: PathAliases = { baseUrl: null, paths: {} };
    for (const imp of symbols_.imports) {
      if (imp.reexport) continue;
      const resolvedPath = resolveImportPath(
        path.join(rootDir, depRelPath),
        imp.source,
        rootDir,
        aliases_,
      );
      edgesAdded += resolveBarrelImportEdges(db, stmts, fileNodeRow_.id, resolvedPath, imp);
    }
  }
  return edgesAdded;
}

/**
 * Two-pass reverse-dep cascade:
 *   1. Rebuild direct edges (creating `reexports` edges for barrels).
 *   2. Add barrel import edges (which need `reexports` edges to exist).
 * Returns both the gross edges-added count and the pre-deletion edge count
 * for all reverse deps so callers can compute a true net delta.
 */
async function runReverseDepCascade(
  db: BetterSqlite3Database,
  rootDir: string,
  reverseDeps: string[],
  stmts: IncrementalStmts,
  engineOpts: EngineOpts,
  cache: unknown,
): Promise<{ edgesAdded: number; reverseDepsEdgesBefore: number }> {
  const { depSymbols, reverseDepsEdgesBefore } = await parseReverseDeps(
    db,
    rootDir,
    reverseDeps,
    stmts,
    engineOpts,
    cache,
  );

  let edgesAdded = 0;
  // Pass 1: direct edges only (no barrel resolution) — creates reexports edges
  for (const [depRelPath, symbols_] of depSymbols) {
    edgesAdded += rebuildReverseDepEdges(db, rootDir, depRelPath, symbols_, stmts, true);
  }
  // Pass 2: add barrel import edges (reexports edges now exist)
  edgesAdded += emitBarrelImportEdgesForReverseDeps(db, stmts, depSymbols, rootDir);
  return { edgesAdded, reverseDepsEdgesBefore };
}

/**
 * Parse a single file and update the database incrementally.
 */
export async function rebuildFile(
  db: BetterSqlite3Database,
  rootDir: string,
  filePath: string,
  stmts: IncrementalStmts,
  engineOpts: EngineOpts,
  cache: unknown,
  options: { diffSymbols?: (old: unknown[], new_: unknown[]) => unknown } = {},
): Promise<RebuildResult | null> {
  const { diffSymbols } = options;
  const relPath = normalizePath(path.relative(rootDir, filePath));
  const oldNodes = stmts.countNodes.get(relPath)?.c || 0;
  const edgesBefore = stmts.countEdges.get(relPath)?.c || 0;
  const oldSymbols: unknown[] = diffSymbols ? stmts.listSymbols.all(relPath) : [];

  // Find reverse-deps BEFORE purging (edges still reference the old nodes)
  const reverseDeps = findReverseDeps(db, relPath);

  // Purge ancillary tables (incl. embeddings), edges, and nodes in one pass.
  // Embeddings must be purged before nodes — better-sqlite3 enforces foreign
  // keys by default, and `embeddings.node_id` references `nodes.id`. Issue #1176.
  // `purgeHashes: false` preserves file_hashes for the next incremental build.
  purgeFileData(db, relPath, { purgeHashes: false });

  if (!fs.existsSync(filePath)) {
    if (cache) (cache as { remove(p: string): void }).remove(filePath);
    // The file no longer exists, so it has no edges to keep in sync with a
    // hash — delete it immediately (mirrors the full-build removed-file path
    // in insertNodes.ts, which is likewise unconditional).
    stmts.deleteFileHash.run(relPath);
    return buildDeletionResult(relPath, oldNodes, edgesBefore, oldSymbols, diffSymbols);
  }

  let code: string;
  try {
    code = readFileSafe(filePath);
  } catch (err) {
    warn(`Cannot read ${relPath}: ${(err as Error).message}`);
    return null;
  }

  const symbols = await parseFileIncremental(cache, filePath, code, engineOpts);
  if (!symbols) return null;

  insertFileNodes(stmts, relPath, symbols);

  const newNodes = stmts.countNodes.get(relPath)?.c || 0;
  const newSymbols: unknown[] = diffSymbols ? stmts.listSymbols.all(relPath) : [];

  const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (!fileNodeRow)
    return {
      file: relPath,
      nodesAdded: newNodes,
      nodesRemoved: oldNodes,
      edgesAdded: 0,
      edgesBefore,
    };

  let edgesAdded = rebuildEdgesForTargetFile(db, stmts, relPath, symbols, fileNodeRow, rootDir);
  const { edgesAdded: cascadeEdges, reverseDepsEdgesBefore } = await runReverseDepCascade(
    db,
    rootDir,
    reverseDeps,
    stmts,
    engineOpts,
    cache,
  );
  edgesAdded += cascadeEdges;
  // Include pre-deletion edge counts from reverse deps so the net delta
  // (edgesAdded - edgesBefore) is correct even when the cascade re-inserts
  // their edges unchanged.
  const totalEdgesBefore = edgesBefore + reverseDepsEdgesBefore;

  // Commit file_hashes now that relPath's edges have been fully rebuilt to
  // match `code` (#1731). Writing this any earlier — or not at all, as
  // before this fix — would leave file_hashes stale relative to the edges
  // rebuildEdgesForTargetFile just wrote, so the next full/incremental
  // `codegraph build` would either redundantly reprocess an already-correct
  // file (stale-hash direction) or, combined with other divergent writers,
  // risk trusting a hash that doesn't actually reflect these edges.
  const stat = fileStat(filePath);
  if (stat) {
    stmts.upsertFileHash.run(relPath, fileHash(code), stat.mtime, stat.size);
  }

  const symbolDiff = diffSymbols ? diffSymbols(oldSymbols, newSymbols) : null;
  const event = oldNodes === 0 ? 'added' : 'modified';

  return {
    file: relPath,
    nodesAdded: newNodes,
    nodesRemoved: oldNodes,
    edgesAdded,
    edgesBefore: totalEdgesBefore,
    deleted: false,
    event,
    symbolDiff,
    nodesBefore: oldNodes,
    nodesAfter: newNodes,
  };
}
