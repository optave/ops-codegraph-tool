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
import { PROPAGATION_HOP_PENALTY } from '../../../extractors/javascript.js';
import { debug, warn } from '../../../infrastructure/logger.js';
import { normalizePath, TS_NATIVE_CONFIDENCE_FLOOR } from '../../../shared/constants.js';
import { FLAG_ONLY_DYNAMIC_KINDS, isTypeErasedImportTarget } from '../../../shared/kinds.js';
import type {
  BetterSqlite3Database,
  Call,
  EngineOpts,
  ExtractorOutput,
  PathAliases,
  SqliteStatement,
} from '../../../types.js';
import { parseFileIncremental } from '../../parser.js';
import { computeConfidence, resolveImportPath } from '../resolve.js';
import {
  buildPointsToMapForFile,
  type PointsToMap,
  resolveViaPointsTo,
} from '../resolver/points-to.js';
import {
  type CallNodeLookup,
  findCaller,
  isModuleScopedLanguage,
  resolveCallTargets,
  resolveDefinePropertyAccessorTarget,
  resolveHierarchyTargets,
  resolveReceiverEdge,
  resolveSameClassQualifiedMethod,
} from './call-resolver.js';
import {
  buildChaContextFromDb,
  type ChaContext,
  resolveChaTargets,
  resolveThisDispatch,
} from './cha.js';
import {
  BUILTIN_RECEIVERS,
  CHA_DISPATCH_PENALTY,
  CHA_TYPED_DISPATCH_CONFIDENCE,
  fileHash,
  fileStat,
  readFileSafe,
} from './helpers.js';
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
  edgesAdded += buildClassHierarchyEdges(
    db,
    stmts,
    depRelPath,
    symbols,
    importedNames,
    importedOriginalNames,
  );
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

/**
 * KNOWN LIMITATION, tracked separately in #1967: this is `codegraph watch`'s
 * single-file rebuild path (see `watcher.ts`) — unlike the `codegraph build`
 * resolver (`resolveBarrelExport` in resolve-imports.ts, fixed for #1823),
 * this has no way to recover a barrel's `export { X as Y } from …` rename
 * table when the barrel file itself isn't part of the current watch batch —
 * that mapping only exists in the barrel's freshly-parsed `Import.renamedImports`,
 * which isn't persisted to the DB and this function has no reparse access to.
 * It therefore still resolves purely by direct name match — renamed barrel
 * re-exports are not resolved when only a consumer file changes under watch.
 * `name` in the result mirrors the shared `CallNodeLookup.resolveBarrel`
 * shape but is always just the input `symbolName` unchanged.
 */
function resolveBarrelTarget(
  db: BetterSqlite3Database,
  barrelPath: string,
  symbolName: string,
  visited: Set<string> = new Set(),
): { file: string; name: string } | null {
  if (visited.has(barrelPath)) return null;
  visited.add(barrelPath);

  const { reexportTargetsStmt, hasDefStmt } = getBarrelStmts(db);

  // Find re-export targets from this barrel
  const reexportTargets = reexportTargetsStmt.all(barrelPath) as Array<{ file: string }>;

  for (const { file: targetFile } of reexportTargets) {
    // Check if the symbol is defined in this target file
    const hasDef = hasDefStmt.get(symbolName, targetFile);
    if (hasDef) return { file: targetFile, name: symbolName };

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
    const resolved = resolveBarrelTarget(db, resolvedPath, original);
    const actualSource = resolved?.file;
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
 *
 * For `edgeKind === 'imports-type'`, a specifier gets an edge when either
 * it's actually marked type-only (whole-statement or inline per-specifier,
 * #1813 — a mixed `import { value, type Foo }` must not credit `value` on
 * this basis alone), or the resolved target is a TypeScript
 * interface/type-alias declaration (`isTypeErasedImportTarget`) — those
 * kinds are erased before runtime, so a plain `import { Foo } from 'y'` (no
 * `type` keyword) is the only consumption signal `codegraph exports` can
 * observe for them (#1833).
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
  for (const { original, typeOnly } of importNamePairs(imp)) {
    let targetFile = resolvedPath;
    let targetName = original;
    if (db && isBarrelFile(db, resolvedPath)) {
      const resolved = resolveBarrelTarget(db, resolvedPath, original);
      if (resolved) {
        targetFile = resolved.file;
        targetName = resolved.name;
      }
    }
    const candidates = stmts.findNodeInFile.all(targetName, targetFile) as Array<{
      id: number;
      file: string;
      kind: string;
    }>;
    if (candidates.length === 0) continue;
    const target = candidates[0]!;
    if (
      edgeKind === 'imports-type' &&
      !typeOnly &&
      !isTypeErasedImportTarget(target.kind, targetFile)
    ) {
      continue;
    }
    stmts.insertEdge.run(fileNodeId, target.id, edgeKind, 1.0, 0);
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

  // Always attempted (not just for `import type`/inline-`type` specifiers) —
  // emitNamedSymbolEdges also credits plain specifiers that resolve to a
  // TypeScript interface/type-alias declaration (#1833).
  if (!imp.reexport) {
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
      let targetName = original;
      if (isBarrelFile(db, resolvedPath)) {
        const resolved = resolveBarrelTarget(db, resolvedPath, original);
        if (resolved) {
          targetFile = resolved.file;
          targetName = resolved.name;
        }
      }
      importedNames.set(local, targetFile);
      if (targetName !== local) importedOriginalNames.set(local, targetName);
    }
  }
  return { importedNames, importedOriginalNames };
}

// ── Class hierarchy edges ───────────────────────────────────────────────

type NodeWithKind = { id: number; kind: string; file: string };

const HIERARCHY_SOURCE_KINDS = new Set(['class', 'struct', 'record', 'enum']);
const EXTENDS_TARGET_KINDS = new Set(['class', 'struct', 'trait', 'record']);
const IMPLEMENTS_TARGET_KINDS = new Set(['interface', 'trait', 'class']);

/**
 * Emit `extends`/`implements` edges for class/struct/trait heritage clauses.
 *
 * Target resolution goes through `resolveHierarchyTargets` (#1812) — same-file
 * declaration first, then the file's actually-resolved import, only falling
 * back to a same-language-family global-by-name match as a last resort —
 * instead of matching the heritage name against every node in the graph
 * regardless of file or language. Mirrors the full-build `buildClassHierarchyEdges`
 * in build-edges.ts.
 */
function buildClassHierarchyEdges(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  relPath: string,
  symbols: ExtractorOutput,
  importedNames: ReadonlyMap<string, string>,
  importedOriginalNames?: ReadonlyMap<string, string>,
): number {
  let edgesAdded = 0;
  const lookup = makeIncrementalLookup(db, stmts);
  for (const cls of symbols.classes) {
    const sourceRow = (stmts.findNodeInFile.all(cls.name, relPath) as NodeWithKind[]).find((n) =>
      HIERARCHY_SOURCE_KINDS.has(n.kind),
    );
    if (!sourceRow) continue;

    if (cls.extends) {
      for (const t of resolveHierarchyTargets(
        lookup,
        cls.extends,
        relPath,
        importedNames,
        EXTENDS_TARGET_KINDS,
        importedOriginalNames,
      )) {
        stmts.insertEdge.run(sourceRow.id, t.id, 'extends', 1.0, 0);
        edgesAdded++;
      }
    }
    if (cls.implements) {
      for (const t of resolveHierarchyTargets(
        lookup,
        cls.implements,
        relPath,
        importedNames,
        IMPLEMENTS_TARGET_KINDS,
        importedOriginalNames,
      )) {
        stmts.insertEdge.run(sourceRow.id, t.id, 'implements', 1.0, 0);
        edgesAdded++;
      }
    }
  }
  return edgesAdded;
}

// ── Extended edge insertion (technique / dynamic_kind) ──────────────────

// Lazily-cached prepared statement for `calls` edges that need `technique`
// and/or `dynamic_kind` set at insert time — points-to (#1852), CHA/RTA
// dispatch (#1852), and dynamic-sink edges (#1852). The shared
// `IncrementalStmts.insertEdge` (built by `prepareWatcherStatements` in
// watcher.ts) only covers the 5 base columns and always leaves `technique`
// NULL, which `backfillIncrementalEdgeTechniques` below then backfills to
// 'ts-native' — correct for direct-resolution edges, but wrong for these.
// Runs its own INSERT directly against `db`, bypassing the `stmts`
// abstraction, mirroring how `deleteOutgoingEdges`/`backfillIncrementalEdgeTechniques`
// already do for statements outside the shared watcher.ts pool.
let _extEdgeDb: BetterSqlite3Database | null = null;
let _insertCallEdgeExtStmt: SqliteStatement | null = null;

function getInsertCallEdgeExtStmt(db: BetterSqlite3Database): SqliteStatement {
  if (_extEdgeDb !== db) {
    _extEdgeDb = db;
    _insertCallEdgeExtStmt = db.prepare(
      `INSERT INTO edges (source_id, target_id, kind, confidence, dynamic, technique, dynamic_kind)
       VALUES (?, ?, 'calls', ?, ?, ?, ?)`,
    );
  }
  return _insertCallEdgeExtStmt!;
}

/** Insert a `calls` edge with an explicit technique and/or dynamic_kind. */
function insertCallEdgeExt(
  db: BetterSqlite3Database,
  sourceId: number,
  targetId: number,
  confidence: number,
  dynamic: 0 | 1,
  technique: string | null,
  dynamicKind: string | null,
): void {
  getInsertCallEdgeExtStmt(db).run(sourceId, targetId, confidence, dynamic, technique, dynamicKind);
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
 * Apply fallback resolution strategies for a single call site when the
 * primary resolveCallTargets pass returned no targets.
 *
 * Runs in order:
 *   1. Same-class `this.method()` fallback.
 *   2. Same-class bare-call fallback for non-JS/TS class-scoped languages
 *      (e.g. C# static sibling calls: `IsValidEmail()` inside
 *      `Validators.ValidateUser` resolves to `Validators.IsValidEmail`).
 *   3. Object.defineProperty accessor fallback (this-calls inside getter/setter).
 *
 * Mirrors the same-class fallback strategies in `resolveFallbackTargets`
 * (stages/build-edges.ts, full-build path). The Kotlin-reflection
 * pre-qualify and reflection-keyExpr fallbacks are intentionally not
 * mirrored here — that narrower, language-specific gap is tracked
 * separately (#1993), not by this function. The broader points-to/CHA/
 * dynamic-sink gap this comment used to reference is now fixed by
 * `buildCallEdges`/`applyChaDispatchPostPass` below (#1852).
 */
function applyCallFallbacks(
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

  // Strategy 2: same-class bare-call fallback. Skipped for JS/TS, where a
  // bare call is module-scoped, not class-scoped (mirrors
  // resolveSameClassBareCallFallback in stages/build-edges.ts).
  if (!call.receiver && callerName != null && !isModuleScopedLanguage(relPath)) {
    const s2 = resolveSameClassQualifiedMethod(call.name, callerName, relPath, lookup);
    if (s2.length > 0) return s2;
  }

  // Strategy 3: Object.defineProperty accessor fallback. Shared with the
  // full-build path (stages/build-edges.ts) via call-resolver.ts so both
  // paths apply the same function/method kind filter (issue #1766).
  if (call.receiver === 'this' && callerName != null && definePropertyReceivers) {
    return resolveDefinePropertyAccessorTarget(
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

/**
 * Phase 8.3/8.3c pts fallback for calls with no receiver, when the primary
 * resolveCallTargets + applyCallFallbacks chain found nothing. Mirrors
 * `emitPtsNoReceiverEdges` (stages/build-edges.ts, full-build path) — see
 * that function's docstring for the full case breakdown (dynamic calls,
 * scoped/module/flat pts keys).
 *
 * Unlike the full-build version, a pts edge here shares `seenCallEdges` with
 * direct-call edges rather than a separate `ptsEdgeRows` map, so a later
 * direct call to the same target in the same file is skipped (not upgraded
 * to the higher direct-call confidence) if a pts edge already claimed the
 * pair — a narrow, documented gap from full-build parity (tracked in #1852's
 * follow-up), not a missing edge.
 */
function emitIncrementalPtsNoReceiverEdges(
  db: BetterSqlite3Database,
  call: Call,
  caller: { id: number; callerName: string | null },
  relPath: string,
  importedNames: Map<string, string>,
  lookup: CallNodeLookup,
  typeMap: Map<string, unknown>,
  ptsMap: PointsToMap,
  fnRefBindingLhs: ReadonlySet<string>,
  seenCallEdges: Set<string>,
  importedOriginalNames: ReadonlyMap<string, string> | undefined,
): number {
  const scopedPtsKey = caller.callerName != null ? `${caller.callerName}::${call.name}` : null;
  // Module-level calls (callerName === null) use the '<module>' sentinel emitted by
  // extractSpreadForOfWalk for top-level for-of loops.
  const modulePtsKey =
    caller.callerName === null && ptsMap.has(`<module>::${call.name}`)
      ? `<module>::${call.name}`
      : null;
  const flatPtsKey =
    !call.dynamic && fnRefBindingLhs.has(call.name) && ptsMap.has(call.name) ? call.name : null;

  if (
    !(
      call.dynamic ||
      (scopedPtsKey != null && ptsMap.has(scopedPtsKey)) ||
      modulePtsKey != null ||
      flatPtsKey != null
    )
  )
    return 0;

  const ptsLookupName = call.dynamic
    ? call.name
    : scopedPtsKey != null && ptsMap.has(scopedPtsKey)
      ? scopedPtsKey
      : modulePtsKey != null
        ? modulePtsKey
        : flatPtsKey!;

  let edgesAdded = 0;
  const isDynamic: 0 | 1 = call.dynamic ? 1 : 0;
  for (const alias of resolveViaPointsTo(ptsLookupName, ptsMap)) {
    const { targets: aliasTargets, importedFrom: aliasFrom } = resolveCallTargets(
      lookup,
      { name: alias },
      relPath,
      importedNames,
      typeMap,
      undefined,
      importedOriginalNames,
    );
    const sortedAliasTargets =
      aliasTargets.length > 1
        ? [...aliasTargets].sort(
            (a, b) =>
              computeConfidence(relPath, b.file, aliasFrom ?? null) -
              computeConfidence(relPath, a.file, aliasFrom ?? null),
          )
        : aliasTargets;
    for (const t of sortedAliasTargets) {
      const edgeKey = `${caller.id}|${t.id}`;
      if (t.id !== caller.id && !seenCallEdges.has(edgeKey)) {
        const conf =
          computeConfidence(relPath, t.file, aliasFrom ?? null) - PROPAGATION_HOP_PENALTY;
        if (conf > 0) {
          seenCallEdges.add(edgeKey);
          insertCallEdgeExt(db, caller.id, t.id, conf, isDynamic, 'points-to', null);
          edgesAdded++;
        }
      }
    }
  }
  return edgesAdded;
}

/**
 * Phase 8.3f pts fallback for unresolved receiver calls via object-rest
 * param bindings (`rest.prop()`). Mirrors `emitPtsReceiverEdges`
 * (stages/build-edges.ts, full-build path).
 */
function emitIncrementalPtsReceiverEdges(
  db: BetterSqlite3Database,
  call: Call,
  caller: { id: number; callerName: string | null },
  relPath: string,
  importedNames: Map<string, string>,
  lookup: CallNodeLookup,
  typeMap: Map<string, unknown>,
  ptsMap: PointsToMap,
  seenCallEdges: Set<string>,
  importedOriginalNames: ReadonlyMap<string, string> | undefined,
): number {
  const receiverKey = `${call.receiver}.${call.name}`;
  if (!ptsMap.has(receiverKey)) return 0;

  let edgesAdded = 0;
  const isDynamic: 0 | 1 = call.dynamic ? 1 : 0;
  for (const alias of resolveViaPointsTo(receiverKey, ptsMap)) {
    const { targets: aliasTargets, importedFrom: aliasFrom } = resolveCallTargets(
      lookup,
      { name: alias },
      relPath,
      importedNames,
      typeMap,
      undefined,
      importedOriginalNames,
    );
    const sortedAliasTargets =
      aliasTargets.length > 1
        ? [...aliasTargets].sort(
            (a, b) =>
              computeConfidence(relPath, b.file, aliasFrom ?? null) -
              computeConfidence(relPath, a.file, aliasFrom ?? null),
          )
        : aliasTargets;
    for (const t of sortedAliasTargets) {
      const edgeKey = `${caller.id}|${t.id}`;
      if (t.id !== caller.id && !seenCallEdges.has(edgeKey)) {
        const conf =
          computeConfidence(relPath, t.file, aliasFrom ?? null) - PROPAGATION_HOP_PENALTY;
        if (conf > 0) {
          seenCallEdges.add(edgeKey);
          insertCallEdgeExt(db, caller.id, t.id, conf, isDynamic, 'points-to', null);
          edgesAdded++;
        }
      }
    }
  }
  return edgesAdded;
}

/**
 * Flag-only dynamic kinds (eval, computed-key, reflection, unresolved-dynamic)
 * left with no resolved target get a confidence=0.0 sink edge to the file
 * node instead of being silently dropped — queryable via `codegraph roles
 * --dynamic`. Mirrors Step 7 of `buildFileCallEdges` (stages/build-edges.ts,
 * full-build path).
 */
function emitDynamicSinkEdge(
  db: BetterSqlite3Database,
  call: Call,
  caller: { id: number },
  fileNodeRow: { id: number },
  seenCallEdges: Set<string>,
): number {
  if (!call.dynamicKind || !FLAG_ONLY_DYNAMIC_KINDS.has(call.dynamicKind)) return 0;
  // Key per (caller, file, kind) so each kind gets at most one sink edge per caller.
  const sinkKey = `${caller.id}:${fileNodeRow.id}:${call.dynamicKind}`;
  if (seenCallEdges.has(sinkKey)) return 0;
  seenCallEdges.add(sinkKey);
  insertCallEdgeExt(db, caller.id, fileNodeRow.id, 0.0, 1, null, call.dynamicKind);
  return 1;
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
  // Phase 8.3 pts map (#1852) — same per-file construction the full-build
  // JS path uses (buildPointsToMapForFile, shared via resolver/points-to.js).
  const ptsMap = buildPointsToMapForFile(symbols, importedNames);
  const fnRefBindingLhs = new Set(symbols.fnRefBindings?.map((b) => b.lhs) ?? []);
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

    let targets = applyCallFallbacks(
      call,
      caller.callerName,
      relPath,
      typeMap,
      lookup,
      symbols.definePropertyReceivers,
      initialTargets,
    );

    // #1771/#1784: value-ref references resolve against function/method/
    // class-kind targets only (class included for `instanceof ClassName`,
    // #1784) — mirrors the same filter in resolveFallbackTargets
    // (stages/build-edges.ts, full-build path).
    if (call.dynamicKind === 'value-ref') {
      targets = targets.filter(
        (t) => t.kind === 'function' || t.kind === 'method' || t.kind === 'class',
      );
    }

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

    // Phase 8.3/8.3c/8.3f pts fallback (#1852): only fires when the primary +
    // fallback resolution chain above found nothing.
    if (targets.length === 0 && ptsMap) {
      if (!call.receiver) {
        edgesAdded += emitIncrementalPtsNoReceiverEdges(
          db,
          call,
          caller,
          relPath,
          importedNames,
          lookup,
          typeMap,
          ptsMap,
          fnRefBindingLhs,
          seenCallEdges,
          importedOriginalNames,
        );
      } else if (
        !BUILTIN_RECEIVERS.has(call.receiver) &&
        call.receiver !== 'this' &&
        call.receiver !== 'self' &&
        call.receiver !== 'super'
      ) {
        edgesAdded += emitIncrementalPtsReceiverEdges(
          db,
          call,
          caller,
          relPath,
          importedNames,
          lookup,
          typeMap,
          ptsMap,
          seenCallEdges,
          importedOriginalNames,
        );
      }
    }

    // Flag-only dynamic kinds with no resolved target → sink edge (#1852).
    if (targets.length === 0) {
      edgesAdded += emitDynamicSinkEdge(db, call, caller, fileNodeRow, seenCallEdges);
    }
  }
  return edgesAdded;
}

// ── technique backfill (#1744) ──────────────────────────────────────────

/**
 * Backfill `technique = 'ts-native'` on direct-resolution `calls` edges just
 * written by `buildCallEdges`/`emitIncrementalCallEdges` above, which insert
 * edges via `stmts.insertEdge.run(...)` without ever setting `technique`,
 * leaving it NULL.
 *
 * `'ts-native'` is not an engine marker — it is the resolution-technique
 * label the full-build paths apply to every directly name/type-resolved
 * `calls` edge, in both the WASM/JS pipeline (`emitDirectCallEdgesForCall` in
 * stages/build-edges.ts) and the native pipeline (`buildCallEdgesNative`,
 * same file), as opposed to `'points-to'` (alias/pts fallback) or `'cha'` /
 * `'super-dispatch'` (virtual-dispatch expansion).
 *
 * `AND dynamic_kind IS NULL` excludes the flag-only dynamic-call sink edges
 * `emitDynamicSinkEdge` inserts (#1852) — those intentionally keep
 * `technique = NULL` forever (matching the full-build WASM/JS path's own
 * sink-edge rows), with `dynamic_kind` alone marking why they exist. Without
 * this exclusion, this blanket backfill would mislabel every sink edge as a
 * direct resolution.
 *
 * Mirrors `applyEdgeTechniquesAfterNativeInsert` (full-build JS pipeline,
 * stages/build-edges.ts) and `backfillEdgeTechniquesAfterNativeOrchestrator`
 * (stages/native-orchestrator.ts): scope to the just-rebuilt files' source
 * nodes, backfill NULL technique to 'ts-native', then lift any resulting
 * ts-native edge below the confidence floor up to it — so a `calls` edge's
 * `technique` (and, transitively, its confidence floor) no longer depends on
 * whether it was last touched by a full build or a single-file watch rebuild.
 *
 * Scoped to `touchedFiles` (the rebuilt file + any reverse-dep cascade
 * files), not a full-table scan. Chunked to stay within SQLite's
 * SQLITE_LIMIT_VARIABLE_NUMBER (999 on older builds).
 */
function backfillIncrementalEdgeTechniques(
  db: BetterSqlite3Database,
  touchedFiles: readonly string[],
): void {
  if (touchedFiles.length === 0) return;
  const CHUNK_SIZE = 500;
  const tx = db.transaction(() => {
    for (let i = 0; i < touchedFiles.length; i += CHUNK_SIZE) {
      const chunk = touchedFiles.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      db.prepare(
        `UPDATE edges SET technique = 'ts-native'
         WHERE kind = 'calls' AND technique IS NULL AND dynamic_kind IS NULL
           AND source_id IN (SELECT id FROM nodes WHERE file IN (${placeholders}))`,
      ).run(...chunk);
      // Lift resolved ts-native edges below the confidence floor for this
      // chunk, matching the floor lift the full-build native paths apply.
      db.prepare(
        `UPDATE edges SET confidence = ?
         WHERE kind = 'calls' AND technique = 'ts-native'
           AND confidence > 0 AND confidence < ?
           AND source_id IN (SELECT id FROM nodes WHERE file IN (${placeholders}))`,
      ).run(TS_NATIVE_CONFIDENCE_FLOOR, TS_NATIVE_CONFIDENCE_FLOOR, ...chunk);
    }
  });
  tx();
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
  edgesAdded += buildClassHierarchyEdges(
    db,
    stmts,
    relPath,
    symbols,
    importedNames,
    importedOriginalNames,
  );
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
 * Returns the gross edges-added count, the pre-deletion edge count for all
 * reverse deps so callers can compute a true net delta, and the parsed
 * `depSymbols` map itself so the CHA post-pass (#1852) can re-iterate each
 * reverse dep's already-parsed `calls` array without a second re-parse.
 */
async function runReverseDepCascade(
  db: BetterSqlite3Database,
  rootDir: string,
  reverseDeps: string[],
  stmts: IncrementalStmts,
  engineOpts: EngineOpts,
  cache: unknown,
): Promise<{
  edgesAdded: number;
  reverseDepsEdgesBefore: number;
  depSymbols: Map<string, ExtractorOutput>;
}> {
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
  return { edgesAdded, reverseDepsEdgesBefore, depSymbols };
}

// ── CHA/RTA dispatch post-pass (#1852) ───────────────────────────────────

/**
 * Seed a dedup set from `calls` edges already in the DB for the given
 * caller-side files, so the CHA post-pass below never re-emits a pair that
 * direct resolution or the pts fallback already wrote — in this rebuild or a
 * prior one. Mirrors the `seen` set construction in `expandChaEdges`
 * (stages/native-orchestrator.ts).
 */
function seedChaSeenEdges(db: BetterSqlite3Database, files: readonly string[]): Set<string> {
  const seen = new Set<string>();
  if (files.length === 0) return seen;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT source_id, target_id FROM edges
         WHERE kind = 'calls' AND source_id IN (SELECT id FROM nodes WHERE file IN (${placeholders}))`,
      )
      .all(...chunk) as Array<{ source_id: number; target_id: number }>;
    for (const r of rows) seen.add(`${r.source_id}|${r.target_id}`);
  }
  return seen;
}

/**
 * Phase 8.5 CHA + RTA dispatch expansion for a single call site — mirrors
 * `emitChaCallEdgesForCall` (stages/build-edges.ts, full-build path).
 */
function emitChaDispatchForCall(
  db: BetterSqlite3Database,
  call: Call,
  caller: { id: number; callerName: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
  chaCtx: ChaContext,
  seenCallEdges: Set<string>,
): number {
  if (!call.receiver || BUILTIN_RECEIVERS.has(call.receiver)) return 0;

  let chaTargets: ReadonlyArray<{ id: number; file: string }> = [];
  let isTypedReceiverDispatch = false;

  if (call.receiver === 'this' || call.receiver === 'self' || call.receiver === 'super') {
    chaTargets = resolveThisDispatch(
      call.name,
      caller.callerName,
      call.receiver,
      chaCtx,
      lookup,
      relPath,
    );
  } else {
    const typeEntry = typeMap.get(call.receiver);
    const typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : (typeEntry as { type?: string }).type
      : null;
    if (typeName) {
      chaTargets = resolveChaTargets(typeName, call.name, chaCtx, lookup);
      isTypedReceiverDispatch = true;
    }
  }

  let edgesAdded = 0;
  for (const t of chaTargets) {
    const edgeKey = `${caller.id}|${t.id}`;
    if (t.id !== caller.id && !seenCallEdges.has(edgeKey)) {
      // Typed-receiver (interface/CHA) dispatch: use CHA_TYPED_DISPATCH_CONFIDENCE
      // — file proximity is not meaningful for virtual dispatch confidence.
      // this/super dispatch keeps computeConfidence-based proximity scoring.
      const conf = isTypedReceiverDispatch
        ? CHA_TYPED_DISPATCH_CONFIDENCE
        : computeConfidence(relPath, t.file, null) - CHA_DISPATCH_PENALTY;
      if (conf > 0) {
        seenCallEdges.add(edgeKey);
        // Tag super-dispatch edges distinctly, matching the full-build convention
        // (super calls are not virtual dispatch).
        const technique = call.receiver === 'super' ? 'super-dispatch' : 'cha';
        insertCallEdgeExt(db, caller.id, t.id, conf, 0, technique, null);
        edgesAdded++;
      }
    }
  }
  return edgesAdded;
}

/**
 * Phase 8.5 CHA + RTA dispatch expansion post-pass for the incremental
 * single-file rebuild path (#1852).
 *
 * Runs AFTER the target file's and every reverse-dep's edges (including
 * class-hierarchy `extends`/`implements` edges) are fully rebuilt, since the
 * DB-driven ChaContext (`buildChaContextFromDb`, builder/cha.ts) depends on
 * that state already being persisted.
 *
 * Iterates the already-parsed `calls` arrays for the rebuilt file and its
 * reverse deps — no re-parse needed, unlike the native full-build's
 * `runPostNativeThisDispatch` (stages/native-orchestrator.ts), which must
 * WASM-re-parse because it never held the raw call sites in memory to begin
 * with (the native engine doesn't persist unresolved receiver info to DB).
 */
function applyChaDispatchPostPass(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  filesWithSymbols: ReadonlyArray<readonly [string, ExtractorOutput]>,
): number {
  const chaCtx = buildChaContextFromDb(db);
  if (chaCtx.implementors.size === 0) return 0;

  const lookup = makeIncrementalLookup(db, stmts);
  const seenCallEdges = seedChaSeenEdges(
    db,
    filesWithSymbols.map(([relPath]) => relPath),
  );

  let edgesAdded = 0;
  for (const [relPath, symbols] of filesWithSymbols) {
    const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;
    const typeMap = coerceTypeMap(symbols);

    for (const call of symbols.calls) {
      const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
      edgesAdded += emitChaDispatchForCall(
        db,
        call,
        caller,
        relPath,
        typeMap,
        lookup,
        chaCtx,
        seenCallEdges,
      );
    }
  }
  return edgesAdded;
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
  const {
    edgesAdded: cascadeEdges,
    reverseDepsEdgesBefore,
    depSymbols,
  } = await runReverseDepCascade(db, rootDir, reverseDeps, stmts, engineOpts, cache);
  edgesAdded += cascadeEdges;

  // Phase 8.5 CHA + RTA dispatch expansion post-pass (#1852) — runs after all
  // of this rebuild's class-hierarchy edges are in the DB (target file +
  // reverse deps), since the DB-driven ChaContext depends on them.
  edgesAdded += applyChaDispatchPostPass(db, stmts, [[relPath, symbols], ...depSymbols]);

  // Backfill technique='ts-native' (and the confidence floor) for this
  // rebuild's calls edges — buildCallEdges above inserts edges without a
  // technique value, unlike a full rebuild of either engine, which always
  // tags directly-resolved calls edges 'ts-native' (#1744). Runs after the
  // CHA post-pass, which sets its own non-NULL technique ('cha'/'super-dispatch')
  // at insert time via insertCallEdgeExt — this backfill's `technique IS NULL`
  // filter correctly skips those rows.
  backfillIncrementalEdgeTechniques(db, [relPath, ...reverseDeps]);

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
