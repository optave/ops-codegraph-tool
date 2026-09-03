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
import { escapeLike } from '../../../db/query-builder.js';
import { PROPAGATION_HOP_PENALTY } from '../../../extractors/javascript.js';
import { classifyNodeRoles } from '../../../features/structure.js';
import { debug, warn } from '../../../infrastructure/logger.js';
import { getOrCreatePerDbChunkStmt } from '../../../shared/chunked-stmt-cache.js';
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
import {
  clearCargoTargetOverridesCache,
  clearExportsCache,
  clearPythonImportRootsCache,
  computeConfidence,
  resolveImportPath,
  resolvePythonSubmodule,
} from '../resolve.js';
import {
  buildPointsToMapForFile,
  correlatedEvidenceKey,
  objectLiteralSiteKey,
  type PointsToMap,
  resolveSitesViaPointsTo,
  resolveViaPointsTo,
} from '../resolver/points-to.js';
import type { ResolvedCandidate } from '../resolver/strategy.js';
import {
  type CallNodeLookup,
  collectInvokedPropertyNames,
  collectInvokedPropertySites,
  findCaller,
  isModuleScopedLanguage,
  resolveCallTargets,
  resolveDefinePropertyAccessorTarget,
  resolveHierarchyTargets,
  resolveKotlinReflectionPreQualified,
  resolveReceiverEdge,
  resolveReflectionKeyExprFallback,
  resolveSameClassQualifiedMethod,
} from './call-resolver.js';
import {
  buildChaContextFromDb,
  type ChaContext,
  resolveChaTargets,
  resolveThisDispatch,
} from './cha.js';
import {
  applyPyprojectScriptAttribution,
  persistEntrypointCalls,
  projectEntrypointAttribution,
} from './entrypoints.js';
import {
  BUILTIN_RECEIVERS,
  CHA_DISPATCH_PENALTY,
  CHA_TYPED_DISPATCH_CONFIDENCE,
  fileHash,
  fileStat,
  loadPathAliases,
  mergeConfigAliases,
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
   * True when `file` has a function/method-kind node other than `excludeId`
   * whose span encloses `line` — backs `CallNodeLookup.hasEnclosingCallable`
   * for the watch-mode path (issue #2238 follow-up, Greptile finding on PR
   * #2400). Params: `(file, excludeId, line, line)`.
   */
  hasEnclosingCallable: { get: (...params: unknown[]) => unknown };
  /**
   * Upsert a `file_hashes` row: `(relPath, hash, mtime, size)`. Called only
   * after a file's edges have been fully rebuilt (#1731) — see the call site
   * in `rebuildFile` for why this can't happen any earlier.
   */
  upsertFileHash: { run: (...params: unknown[]) => unknown };
  /** Delete a `file_hashes` row for a file removed from disk. */
  deleteFileHash: { run: (...params: unknown[]) => unknown };
  /**
   * Mark a node `exported = 1`, keyed by `(name, kind, file, line)` —
   * mirrors the full-build path's `markExportedSymbols` (issue #2220).
   */
  markExported: { run: (...params: unknown[]) => unknown };
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

/**
 * Insert this file's node, its definitions and their children, and its
 * exports — mirroring `insertDefinitionsAndExports`/`collectChildRowsAndFileEdges`
 * in `stages/insert-nodes.ts` (the full-build path) so a symbol touched only
 * by watch-mode rebuilds gets the same `qualified_name`/`scope`/`visibility`/
 * `parent_id`/`content_hash`/`exported` columns a full or regular incremental
 * `codegraph build` would have given it (issue #2220) — downstream queries
 * that filter/join on those columns must not behave differently depending on
 * which rebuild path last touched a symbol.
 *
 * `def.name` scoping mirrors insert-nodes.ts exactly: a dotted definition
 * name (e.g. some extractors' `ClassName.methodName` convention) yields a
 * `scope` of everything before the last dot; children get `parent_id` set to
 * their def's real node id (looked up post-insert, not `lastInsertRowid`,
 * since `INSERT OR IGNORE` leaves that unreliable for an already-existing
 * row on a re-rebuild) and a `qualified_name` of `${def.name}.${child.name}`.
 */
function insertFileNodes(stmts: IncrementalStmts, relPath: string, symbols: ExtractorOutput): void {
  stmts.insertNode.run(relPath, 'file', relPath, 0, null, null, null, null, null, null, null);
  for (const def of symbols.definitions) {
    const dotIdx = def.name.lastIndexOf('.');
    const scope = dotIdx !== -1 ? def.name.slice(0, dotIdx) : null;
    stmts.insertNode.run(
      def.name,
      def.kind,
      relPath,
      def.line,
      def.endLine || null,
      null,
      def.name,
      scope,
      def.visibility ?? null,
      def.contentHash ?? null,
      def.accessorKind ?? null,
    );
    if (def.children?.length) {
      const defId = stmts.getNodeId.get(def.name, def.kind, relPath, def.line)?.id ?? null;
      for (const child of def.children) {
        stmts.insertNode.run(
          child.name,
          child.kind,
          relPath,
          child.line,
          child.endLine || null,
          defId,
          `${def.name}.${child.name}`,
          def.name,
          child.visibility ?? null,
          child.contentHash ?? null,
          null,
        );
      }
    }
  }
  for (const exp of symbols.exports) {
    stmts.insertNode.run(
      exp.name,
      exp.kind,
      relPath,
      exp.line,
      null,
      null,
      exp.name,
      null,
      null,
      null,
      null,
    );
    stmts.markExported.run(exp.name, exp.kind, relPath, exp.line);
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

/**
 * Project-wide known-files list for `resolveImportPath`'s Rust `crate::`/
 * `self::`/`super::` resolution (#2007) — absolute paths, matching
 * `ctx.allFiles`'s format on the full-build path (`resolve-imports.ts`).
 * The full-build path already has this in memory before import resolution
 * runs; a single-file incremental rebuild has no such list, so this queries
 * it from the DB once per `rebuildFile` call and threads it down to every
 * `resolveImportPath` call site in this file (#2216) — without it, a
 * `crate::`/`self::`/`super::` import in a file processed via `codegraph
 * watch` silently fails to resolve even though the same file would resolve
 * correctly in a full rebuild.
 */
function getKnownFilesForIncremental(db: BetterSqlite3Database, rootDir: string): string[] {
  const rows = db.prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'").all() as Array<{
    file: string;
  }>;
  // `r.file` is stored forward-slash-normalized (cross-platform DB
  // consistency) even for a nested relative path like "service/nested.rs".
  // Joining it into rootDir in one path.join() call would leave those
  // internal forward slashes intact on Windows, producing a mixed-separator
  // absolute path that can't exact-match a purely-backslash candidate built
  // elsewhere — so join one segment at a time instead.
  return rows.map((r) => path.join(rootDir, ...r.file.split('/')));
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
  // #2216: see getKnownFilesForIncremental's doc comment.
  knownFiles: readonly string[],
  // #2242: real tsconfig/jsconfig + codegraph-configured aliases, loaded
  // once per rebuildFile invocation and threaded through — a hardcoded
  // empty PathAliases here silently dropped every edge kind for an
  // alias-based import, not just renamed reexports (#1967's narrower fix,
  // now also using this same shared aliases — see persistReexportRenamesForFile).
  aliases: PathAliases,
  // #2077: forwarded to buildCallEdges — see its own param doc.
  maxIterations?: number,
  correlationEnabled = true,
): number {
  const fileNodeRow = stmts.getNodeId.get(depRelPath, 'file', depRelPath, 0);
  if (!fileNodeRow) return 0;

  // #1967: keep this reverse-dep's persisted barrel rename table current if
  // it's itself a barrel — independent of the edges rebuilt below.
  persistReexportRenamesForFile(db, depRelPath, symbols, rootDir, knownFiles, aliases);

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
    knownFiles,
  );
  const { importedNames, importedOriginalNames, namespaceImports } = buildImportedNamesMap(
    symbols,
    rootDir,
    depRelPath,
    aliases,
    db,
    knownFiles,
  );
  edgesAdded += buildCallEdges(
    db,
    stmts,
    depRelPath,
    symbols,
    fileNodeRow,
    importedNames,
    importedOriginalNames,
    maxIterations,
    namespaceImports,
    correlationEnabled,
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
let _renameLookupStmt: SqliteStatement | null = null;
let _renameDeleteStmt: SqliteStatement | null = null;
let _renameInsertStmt: SqliteStatement | null = null;

function getBarrelStmts(db: BetterSqlite3Database): {
  isBarrelStmt: SqliteStatement;
  reexportTargetsStmt: SqliteStatement;
  hasDefStmt: SqliteStatement;
  renameLookupStmt: SqliteStatement;
  renameDeleteStmt: SqliteStatement;
  renameInsertStmt: SqliteStatement;
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
    // #1967: persisted barrel rename pairs — see `resolveBarrelTarget` and
    // `persistReexportRenamesForFile` below.
    _renameLookupStmt = db.prepare(
      `SELECT imported_name, source_file FROM reexport_renames
       WHERE barrel_file = ? AND local_name = ? LIMIT 1`,
    );
    _renameDeleteStmt = db.prepare('DELETE FROM reexport_renames WHERE barrel_file = ?');
    _renameInsertStmt = db.prepare(
      `INSERT INTO reexport_renames (barrel_file, local_name, imported_name, source_file)
       VALUES (?, ?, ?, ?)`,
    );
  }
  return {
    isBarrelStmt: _isBarrelStmt!,
    reexportTargetsStmt: _reexportTargetsStmt!,
    hasDefStmt: _hasDefStmt!,
    renameLookupStmt: _renameLookupStmt!,
    renameDeleteStmt: _renameDeleteStmt!,
    renameInsertStmt: _renameInsertStmt!,
  };
}

function isBarrelFile(db: BetterSqlite3Database, relPath: string): boolean {
  const { isBarrelStmt } = getBarrelStmts(db);
  const reexportCount = (isBarrelStmt.get(relPath) as { c: number } | undefined)?.c;
  return (reexportCount || 0) > 0;
}

// Lazily-cached prepared statements for the #2087 invoked-property-name registry.
let _invokedPropDb: BetterSqlite3Database | null = null;
let _invokedPropOtherFilesStmt: SqliteStatement | null = null;
let _invokedPropDeleteStmt: SqliteStatement | null = null;
let _invokedPropInsertStmt: SqliteStatement | null = null;

function getInvokedPropertyStmts(db: BetterSqlite3Database): {
  otherFilesStmt: SqliteStatement;
  deleteStmt: SqliteStatement;
  insertStmt: SqliteStatement;
} {
  if (_invokedPropDb !== db) {
    _invokedPropDb = db;
    _invokedPropOtherFilesStmt = db.prepare(
      'SELECT DISTINCT name FROM invoked_property_names WHERE file != ?',
    );
    _invokedPropDeleteStmt = db.prepare('DELETE FROM invoked_property_names WHERE file = ?');
    _invokedPropInsertStmt = db.prepare(
      'INSERT OR IGNORE INTO invoked_property_names (file, name) VALUES (?, ?)',
    );
  }
  return {
    otherFilesStmt: _invokedPropOtherFilesStmt!,
    deleteStmt: _invokedPropDeleteStmt!,
    insertStmt: _invokedPropInsertStmt!,
  };
}

/**
 * Graph-wide invoked-property-name evidence for the #1895 liveness check
 * (#2087): this file's own freshly-computed names, unioned with every other
 * file's persisted evidence from `invoked_property_names` — the durable
 * counterpart of the full-build path's whole-`fileSymbols` computation
 * (`collectInvokedPropertyNames` in call-resolver.ts). Excludes this file's
 * OWN persisted rows (not just its fresh ones) since those are about to be
 * replaced by `persistInvokedPropertyNamesForFile` below; querying them here
 * would only ever match what `ownNames` already provides directly.
 */
function collectGraphWideInvokedPropertyNames(
  db: BetterSqlite3Database,
  relPath: string,
  ownNames: ReadonlySet<string>,
): Set<string> {
  const { otherFilesStmt } = getInvokedPropertyStmts(db);
  const names = new Set(ownNames);
  for (const row of otherFilesStmt.all(relPath) as Array<{ name: string }>) {
    names.add(row.name);
  }
  return names;
}

/**
 * Persist this file's invoked-property-name evidence (#2087) into
 * `invoked_property_names` — the durable counterpart of
 * `persistInvokedPropertyNames` in `resolve-imports.ts`/`build-edges.ts`
 * (full-build path), needed here because `codegraph watch`'s single-file
 * rebuild never goes through that stage. Always deletes this file's existing
 * rows first (even when it invokes nothing via member-call syntax anymore)
 * so a file that changed to stop invoking a property never leaves stale
 * rows behind.
 *
 * Called for both the primary rebuilt file and each reverse-dep, mirroring
 * `persistReexportRenamesForFile`.
 */
function persistInvokedPropertyNamesForFile(
  db: BetterSqlite3Database,
  relPath: string,
  ownNames: ReadonlySet<string>,
): void {
  const { deleteStmt, insertStmt } = getInvokedPropertyStmts(db);
  deleteStmt.run(relPath);
  for (const name of ownNames) {
    insertStmt.run(relPath, name);
  }
}

function persistObjectLiteralSitesForFile(
  db: BetterSqlite3Database,
  relPath: string,
  symbols: ExtractorOutput,
): void {
  db.prepare('DELETE FROM object_literal_sites WHERE file = ?').run(relPath);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO object_literal_sites (file, site, escapes) VALUES (?, ?, ?)',
  );
  for (const site of symbols.objectLiteralSites ?? []) {
    insert.run(relPath, site.site, site.escapes ? 1 : 0);
  }
}

function persistInvokedPropertySitesForFile(
  db: BetterSqlite3Database,
  relPath: string,
  keys: ReadonlySet<string>,
): void {
  db.prepare('DELETE FROM invoked_property_sites WHERE file = ?').run(relPath);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO invoked_property_sites (site_key, name, file) VALUES (?, ?, ?)',
  );
  for (const key of keys) {
    const sep = key.lastIndexOf('|');
    if (sep < 0) continue;
    insert.run(key.slice(0, sep), key.slice(sep + 1), relPath);
  }
}

// Lazily-cached prepared statements for the #2138 return-type registry.
let _returnTypesDb: BetterSqlite3Database | null = null;
let _returnTypesDeleteStmt: SqliteStatement | null = null;
let _returnTypesInsertStmt: SqliteStatement | null = null;

function getReturnTypeStmts(db: BetterSqlite3Database): {
  deleteStmt: SqliteStatement;
  insertStmt: SqliteStatement;
} {
  if (_returnTypesDb !== db) {
    _returnTypesDb = db;
    _returnTypesDeleteStmt = db.prepare('DELETE FROM return_types WHERE file = ?');
    _returnTypesInsertStmt = db.prepare(
      'INSERT OR IGNORE INTO return_types (file, fn_name, type_name, confidence) VALUES (?, ?, ?, ?)',
    );
  }
  return { deleteStmt: _returnTypesDeleteStmt!, insertStmt: _returnTypesInsertStmt! };
}

/**
 * Persist this file's return-type evidence (#2138) into `return_types` —
 * the durable counterpart of `persistReturnTypes` in `build-edges.ts`
 * (full-build path), needed here because `codegraph watch`'s single-file
 * rebuild never goes through that stage but DOES purge this file's existing
 * `return_types` row via `purgeFileData` before this function runs. Without
 * this write-back, a file's return-type evidence would be permanently
 * erased the first time it's touched via `codegraph watch` — worse than
 * never having the row at all, since a later scoped `codegraph build`
 * incremental rebuild that depends on it (issue #2138's own fix) would then
 * find nothing where a stale-but-present row previously existed.
 *
 * Always deletes this file's existing rows first (even when it now defines
 * no functions with an inferable return type) so a file that lost its only
 * such function never leaves a stale row behind.
 */
function persistReturnTypesForFile(
  db: BetterSqlite3Database,
  relPath: string,
  symbols: ExtractorOutput,
): void {
  const { deleteStmt, insertStmt } = getReturnTypeStmts(db);
  deleteStmt.run(relPath);
  for (const [fnName, entry] of symbols.returnTypeMap ?? []) {
    insertStmt.run(relPath, fnName, entry.type, entry.confidence);
  }
}

/**
 * Persist this file's barrel re-export rename pairs (`export { X as Y } from
 * …`) into `reexport_renames` (#1967) — the durable counterpart of
 * `persistReexportRenames` in `resolve-imports.ts` (full-build path), needed
 * here because `codegraph watch`'s single-file rebuild never goes through
 * that stage. Always deletes this file's existing rows first (even when it
 * has no reexports left) so a barrel that drops all its renames — or stops
 * being a barrel entirely — never leaves stale rows behind.
 *
 * Called for both the primary rebuilt file and each reverse-dep, so a
 * barrel's rename table stays current whenever *it* is reparsed, regardless
 * of which file triggered this rebuild.
 */
function persistReexportRenamesForFile(
  db: BetterSqlite3Database,
  relPath: string,
  symbols: ExtractorOutput,
  rootDir: string,
  knownFiles: readonly string[],
  // Real tsconfig/jsconfig + codegraph-configured aliases (#1967 review,
  // #2242) — using an empty aliases object here would resolve an
  // alias-based reexport source (e.g. `@utils/foo`) to a bogus non-file
  // specifier, overwriting a correct full-build row with one
  // `resolveBarrelTarget` can never match to a graph node. Callers load
  // this once per rebuildFile invocation (mirroring knownFiles) rather than
  // this function loading its own — a stale cache spanning a whole
  // long-running `codegraph watch` session would be the wrong tradeoff
  // (#1967 review), but a fresh load per rebuild event is exactly as fresh.
  aliases: PathAliases,
): void {
  const { renameDeleteStmt, renameInsertStmt } = getBarrelStmts(db);
  renameDeleteStmt.run(relPath);

  const reexports = symbols.imports.filter((imp) => imp.reexport);
  if (reexports.length === 0) return;

  for (const imp of reexports) {
    if (!imp.renamedImports?.length) continue;
    const source = resolveImportPath(
      path.join(rootDir, relPath),
      imp.source,
      rootDir,
      aliases,
      knownFiles,
    );
    for (const rename of imp.renamedImports) {
      renameInsertStmt.run(relPath, rename.local, rename.imported, source);
    }
  }
}

/**
 * Resolve a symbol through a barrel's re-export chain, consulting persisted
 * rename pairs (`reexport_renames`, #1967) before falling back to a direct
 * name match against the barrel's `reexports` edge targets.
 *
 * This is `codegraph watch`'s single-file rebuild path (see `watcher.ts`) —
 * unlike the `codegraph build` resolver (`resolveBarrelExport` in
 * resolve-imports.ts, fixed for #1823), it cannot re-parse the barrel file
 * itself when it isn't part of the current watch batch. Previously this
 * meant a renamed barrel re-export (`export { X as Y } from …`) could never
 * resolve unless the barrel itself was reparsed in the same batch — the
 * `{ local: Y, imported: X }` mapping only existed in the barrel's
 * freshly-parsed `Import.renamedImports`, which was never persisted.
 * `persistReexportRenamesForFile` (this file) and `persistReexportRenames`
 * (resolve-imports.ts) now write that mapping to `reexport_renames` whenever
 * the barrel itself is parsed (full build, incremental build, or a watch
 * rebuild that happens to touch the barrel directly), so a later watch cycle
 * that only touches a *consumer* can still look up the translation here.
 *
 * If a rename row matches but doesn't resolve (a stale mapping — the target
 * no longer defines that symbol, and it isn't a further barrel hop), this
 * deliberately falls through to the untranslated search below rather than
 * committing to a possibly-wrong answer: unlike `resolveBarrelExport`'s
 * in-memory `reexportMap` (always fresh within a single build), this
 * persisted table can go stale between builds when only a consumer changes.
 *
 * `name` in the result mirrors the shared `CallNodeLookup.resolveBarrel`
 * shape — the actual declared name in `file`, which differs from the input
 * `symbolName` exactly when a rename translation was applied.
 */
function resolveBarrelTarget(
  db: BetterSqlite3Database,
  barrelPath: string,
  symbolName: string,
  visited: Set<string> = new Set(),
): { file: string; name: string } | null {
  if (visited.has(barrelPath)) return null;
  visited.add(barrelPath);

  const { reexportTargetsStmt, hasDefStmt, renameLookupStmt } = getBarrelStmts(db);

  const renameRow = renameLookupStmt.get(barrelPath, symbolName) as
    | { imported_name: string; source_file: string }
    | undefined;
  if (renameRow) {
    const { imported_name: importedName, source_file: sourceFile } = renameRow;
    if (hasDefStmt.get(importedName, sourceFile)) return { file: sourceFile, name: importedName };
    if (isBarrelFile(db, sourceFile)) {
      const deeper = resolveBarrelTarget(db, sourceFile, importedName, visited);
      if (deeper) return deeper;
    }
    // Stale rename mapping — fall through to the untranslated search below.
  }

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
  knownFiles: readonly string[],
): number {
  const resolvedPath = resolveImportPath(
    path.join(rootDir, relPath),
    imp.source,
    rootDir,
    aliases,
    knownFiles,
  );
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
  knownFiles: readonly string[],
): number {
  let edgesAdded = 0;
  for (const imp of symbols.imports) {
    edgesAdded += emitEdgesForImport(
      stmts,
      imp,
      fileNodeId,
      relPath,
      rootDir,
      aliases,
      db,
      knownFiles,
    );
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
  knownFiles: readonly string[],
): {
  importedNames: Map<string, string>;
  importedOriginalNames: Map<string, string>;
  namespaceImports: Map<string, string>;
} {
  const importedNames = new Map<string, string>();
  const importedOriginalNames = new Map<string, string>();
  const namespaceImports = new Map<string, string>();
  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportPath(
      path.join(rootDir, relPath),
      imp.source,
      rootDir,
      aliases,
      knownFiles,
    );
    const namespaceLocals = new Set(imp.namespaceBindings ?? []);
    for (const { local, original } of importNamePairs(imp)) {
      // Module bindings target the module file itself — mirrors the full-build
      // path in stages/build-edges.ts (#2387).
      if (namespaceLocals.has(local)) {
        importedNames.set(local, resolvedPath);
        namespaceImports.set(local, resolvedPath);
        continue;
      }
      const submodule = resolvePythonSubmodule(
        path.join(rootDir, relPath),
        imp.source,
        original,
        rootDir,
        knownFiles,
      );
      if (submodule) {
        importedNames.set(local, submodule);
        namespaceImports.set(local, submodule);
        continue;
      }
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
  return { importedNames, importedOriginalNames, namespaceImports };
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

/**
 * Insert a `calls` edge with an explicit technique and/or dynamic_kind.
 * Returns the inserted row's id so a caller-side map (e.g. `ptsEdgeRows`,
 * #2079) can later upgrade this exact row in place.
 */
function insertCallEdgeExt(
  db: BetterSqlite3Database,
  sourceId: number,
  targetId: number,
  confidence: number,
  dynamic: 0 | 1,
  technique: string | null,
  dynamicKind: string | null,
): number | bigint {
  return getInsertCallEdgeExtStmt(db).run(
    sourceId,
    targetId,
    confidence,
    dynamic,
    technique,
    dynamicKind,
  ).lastInsertRowid;
}

// Lazily-cached prepared statement for upgrading a pts-resolved edge row to
// direct-call confidence in place (#2079) — mirrors the full-build path's
// `ptsEdgeRows` in-memory row mutation (stages/build-edges.ts), adapted for
// the incremental path's per-row DB writes instead of a batched insert array.
let _updateEdgeDb: BetterSqlite3Database | null = null;
let _updateCallEdgeToDirectStmt: SqliteStatement | null = null;

function getUpdateCallEdgeToDirectStmt(db: BetterSqlite3Database): SqliteStatement {
  if (_updateEdgeDb !== db) {
    _updateEdgeDb = db;
    _updateCallEdgeToDirectStmt = db.prepare(
      `UPDATE edges SET confidence = ?, dynamic = ?, technique = 'ts-native' WHERE id = ?`,
    );
  }
  return _updateCallEdgeToDirectStmt!;
}

/** Upgrade a pts-resolved edge row to direct-call confidence/technique in place. */
function upgradePtsEdgeToDirect(
  db: BetterSqlite3Database,
  rowId: number | bigint,
  confidence: number,
  dynamic: 0 | 1,
): void {
  getUpdateCallEdgeToDirectStmt(db).run(confidence, dynamic, rowId);
}

// ── Call edge building ──────────────────────────────────────────────────

function makeIncrementalLookup(db: BetterSqlite3Database, stmts: IncrementalStmts): CallNodeLookup {
  return {
    byNameAndFile: (name, file) => stmts.findNodeInFile.all(name, file) as Array<ResolvedCandidate>,
    byName: (name) => stmts.findNodeByName.all(name) as Array<ResolvedCandidate>,
    isBarrel: (file) => isBarrelFile(db, file),
    resolveBarrel: (barrelFile, symbolName) => resolveBarrelTarget(db, barrelFile, symbolName),
    nodeId: (name, kind, file, line) =>
      stmts.getNodeId.get(name, kind, file, line) as { id: number } | undefined,
    hasEnclosingCallable: (file, line, excludeId) =>
      stmts.hasEnclosingCallable.get(file, excludeId, line, line) !== undefined,
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
 *   3. Reflection-keyExpr fallback (JVM `getMethod("name")`/`invokeMethod("name")`).
 *   4. Object.defineProperty accessor fallback (this-calls inside getter/setter).
 *
 * Mirrors `resolveFallbackTargets` (stages/build-edges.ts, full-build path)
 * in both strategy set and order — including the Kotlin-reflection
 * pre-qualify fallback, which runs before the primary resolution in
 * `buildCallEdges` below rather than here, since it must pre-empt (not
 * follow) resolveCallTargets (#1993).
 */
function applyCallFallbacks(
  call: {
    name: string;
    receiver?: string | null;
    dynamicKind?: string | null;
    keyExpr?: string | null;
  },
  callerName: string | null,
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
  definePropertyReceivers: Map<string, string> | undefined,
  initialTargets: Array<ResolvedCandidate>,
): Array<ResolvedCandidate> {
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

  // Strategy 3: reflection-keyExpr fallback (#1993). Shared with the
  // full-build path via call-resolver.ts.
  const s3 = resolveReflectionKeyExprFallback(call, callerName, relPath, typeMap, lookup);
  if (s3.length > 0) return s3;

  // Strategy 4: Object.defineProperty accessor fallback. Shared with the
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
 *
 * If a target pair was already claimed by a pts-resolved edge (`ptsEdgeRows`,
 * #2079), that row is upgraded in place to direct-call confidence/technique
 * instead of being skipped — mirroring the full-build path's
 * `emitDirectCallEdgesForCall` (stages/build-edges.ts).
 */
function emitIncrementalCallEdges(
  call: { name: string; receiver?: string | null; dynamic?: boolean },
  caller: { id: number; callerName: string | null },
  targets: Array<ResolvedCandidate>,
  importedFrom: string | null | undefined,
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
  importedNames: Map<string, string>,
  seenCallEdges: Set<string>,
  ptsEdgeRows: Map<string, number | bigint>,
  stmts: IncrementalStmts,
  db: BetterSqlite3Database,
): number {
  let edgesAdded = 0;

  for (const t of targets) {
    if (t.id === caller.id) continue;
    const edgeKey = `${caller.id}|${t.id}`;
    if (seenCallEdges.has(edgeKey)) continue;

    const confidence = computeConfidence(relPath, t.file, importedFrom ?? null);
    const dynamic: 0 | 1 = call.dynamic ? 1 : 0;
    const ptsRowId = ptsEdgeRows.get(edgeKey);
    if (ptsRowId !== undefined) {
      upgradePtsEdgeToDirect(db, ptsRowId, confidence, dynamic);
      ptsEdgeRows.delete(edgeKey);
      seenCallEdges.add(edgeKey);
    } else {
      seenCallEdges.add(edgeKey);
      stmts.insertEdge.run(caller.id, t.id, 'calls', confidence, dynamic);
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
 * Pts edges are added to `ptsEdgeRows` (not `seenCallEdges`, #2079) so a
 * later direct call to the same target in the same file upgrades this row
 * in place (`emitIncrementalCallEdges`) instead of being silently dropped —
 * mirroring the full-build path's `ptsEdgeRows` map exactly.
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
  ptsEdgeRows: Map<string, number | bigint>,
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
      if (t.id !== caller.id && !seenCallEdges.has(edgeKey) && !ptsEdgeRows.has(edgeKey)) {
        const conf =
          computeConfidence(relPath, t.file, aliasFrom ?? null) - PROPAGATION_HOP_PENALTY;
        if (conf > 0) {
          const rowId = insertCallEdgeExt(db, caller.id, t.id, conf, isDynamic, 'points-to', null);
          ptsEdgeRows.set(edgeKey, rowId);
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
 *
 * Pts edges are added to `ptsEdgeRows` (not `seenCallEdges`, #2079) — see
 * `emitIncrementalPtsNoReceiverEdges`'s docstring for why.
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
  ptsEdgeRows: Map<string, number | bigint>,
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
      if (t.id !== caller.id && !seenCallEdges.has(edgeKey) && !ptsEdgeRows.has(edgeKey)) {
        const conf =
          computeConfidence(relPath, t.file, aliasFrom ?? null) - PROPAGATION_HOP_PENALTY;
        if (conf > 0) {
          const rowId = insertCallEdgeExt(db, caller.id, t.id, conf, isDynamic, 'points-to', null);
          ptsEdgeRows.set(edgeKey, rowId);
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
  // #2077: resolved from EngineOpts.pointsToMaxIterations (itself sourced
  // from config.analysis.pointsToMaxIterations) so a .codegraphrc.json
  // override applies to watch-mode rebuilds, not just full builds.
  // Undefined falls back to buildPointsToMapForFile's own default parameter.
  maxIterations?: number,
  // #2387: local bindings that name a whole module (Python's `import x as y`),
  // so `y.f()` resolves f inside that module rather than resolving to nothing.
  namespaceImports?: ReadonlyMap<string, string>,
  correlationEnabled = true,
): number {
  const typeMap = buildIncrementalTypeMap(symbols);
  const seenCallEdges = new Set<string>();
  // #2079: pts-resolved edges are tracked here (not seenCallEdges) so a later
  // direct call to the same target in this file upgrades the row in place
  // instead of being dropped by the seenCallEdges dedup guard.
  const ptsEdgeRows = new Map<string, number | bigint>();
  const lookup = makeIncrementalLookup(db, stmts);
  // Phase 8.3 pts map (#1852) — same per-file construction the full-build
  // JS path uses (buildPointsToMapForFile, shared via resolver/points-to.js).
  const ptsMap = buildPointsToMapForFile(symbols, importedNames, maxIterations, relPath);
  const fnRefBindingLhs = new Set(symbols.fnRefBindings?.map((b) => b.lhs) ?? []);
  // #2087: this file's own calls, unioned with every other file's persisted
  // evidence (invoked_property_names) — closes the false-negative window
  // that scoping purely to `symbols.calls` left open, where a consumer's
  // `.resolve(...)` call living in an untouched file was invisible to this
  // rebuild.
  const ownInvokedPropertyNames = collectInvokedPropertyNames([symbols.calls]);
  const invokedPropertyNames = collectGraphWideInvokedPropertyNames(
    db,
    relPath,
    ownInvokedPropertyNames,
  );
  // #2260: same-file-only scope (unlike invokedPropertyNames above, which
  // additionally reads a persisted table) — the table+consumer for this
  // idiom are typically same-file (an internal AST-dispatch table, not an
  // exported API); a cross-file case missed on a scoped rebuild recovers on
  // the next full build. See the fuller trade-off note in stages/build-edges.ts.
  const computedDispatchTableEvidence = new Set(symbols.computedDispatchTableEvidence ?? []);

  function candidateScopesFor(callerName: string | null): readonly string[] {
    const scoped = callerName ?? '<module>';
    const lastDotIdx = callerName?.lastIndexOf('.') ?? -1;
    const afterLastDot = lastDotIdx >= 0 ? callerName!.slice(lastDotIdx + 1) : null;
    return [...new Set([scoped, ...(afterLastDot ? [afterLastDot] : []), '<module>'])];
  }
  const fileCallsWithCaller = new Map([
    [
      relPath,
      symbols.calls.map((call) => ({
        name: call.name,
        receiver: call.receiver,
        dynamicKind: call.dynamicKind,
        callerName: findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow).callerName,
      })),
    ],
  ]);
  const resolveReceiverSites = (_file: string, receiver: string, callerName: string | null) => {
    if (!ptsMap) return [];
    const scopedHits = candidateScopesFor(callerName).flatMap((scope) =>
      resolveSitesViaPointsTo(`${scope}::${receiver}`, ptsMap),
    );
    return scopedHits.concat(resolveSitesViaPointsTo(receiver, ptsMap));
  };
  const correlated = collectInvokedPropertySites(fileCallsWithCaller, resolveReceiverSites);
  try {
    for (const row of db
      .prepare('SELECT site_key, name FROM invoked_property_sites WHERE file != ?')
      .all(relPath) as Array<{ site_key: string; name: string }>) {
      correlated.add(correlatedEvidenceKey(row.site_key, row.name));
    }
  } catch {
    // Table may not exist on a pre-v32 database during the first rebuild.
  }
  const nonEscapingSites = new Set<string>();
  for (const site of symbols.objectLiteralSites ?? []) {
    if (!site.escapes) nonEscapingSites.add(objectLiteralSiteKey(relPath, site.site));
  }
  try {
    for (const row of db
      .prepare('SELECT file, site FROM object_literal_sites WHERE escapes = 0')
      .all() as Array<{ file: string; site: string }>) {
      nonEscapingSites.add(objectLiteralSiteKey(row.file, row.site));
    }
  } catch {
    // Table may not exist on a pre-v32 database during the first rebuild.
  }

  let edgesAdded = 0;

  for (const call of symbols.calls) {
    if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;

    const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
    // Kotlin-reflection pre-qualify (#1993): must pre-empt resolveCallTargets,
    // not follow it as a fallback — mirrors resolveFallbackTargets'
    // preQualifiedTargets check in stages/build-edges.ts.
    const preQualifiedTargets = resolveKotlinReflectionPreQualified(call, relPath, lookup);
    const { targets: initialTargets, importedFrom } =
      preQualifiedTargets.length > 0
        ? { targets: [...preQualifiedTargets], importedFrom: undefined as string | undefined }
        : resolveCallTargets(
            lookup,
            call,
            relPath,
            importedNames,
            typeMap,
            caller.callerName,
            importedOriginalNames,
            namespaceImports,
            caller.enclosingClassHint,
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
      // #1895: object-literal-property value-refs additionally require
      // independent evidence the property is actually invoked somewhere —
      // mirrors the same check in resolveFallbackTargets (stages/build-edges.ts).
      // #2260: OR the property's own dispatch table has confirmed computed-
      // access invocation evidence — see resolveFallbackTargets's fuller
      // comment on this alternate pathway.
      if (call.keyExpr) {
        const siteKey = call.objectLiteralSite
          ? objectLiteralSiteKey(relPath, call.objectLiteralSite)
          : null;
        const localClosed = siteKey !== null && nonEscapingSites.has(siteKey);
        let live = false;
        if (correlationEnabled && localClosed) {
          live = correlated.has(correlatedEvidenceKey(siteKey, call.keyExpr));
        } else if (invokedPropertyNames.has(call.keyExpr)) {
          live = true;
        }
        if (!live && !(call.receiver && computedDispatchTableEvidence.has(call.receiver))) {
          targets = [];
        }
      }
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
      ptsEdgeRows,
      stmts,
      db,
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
          ptsEdgeRows,
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
          ptsEdgeRows,
          importedOriginalNames,
        );
      }
    }

    // Flag-only dynamic kinds with no resolved target → sink edge (#1852).
    if (targets.length === 0) {
      edgesAdded += emitDynamicSinkEdge(db, call, caller, fileNodeRow, seenCallEdges);
    }
  }
  // #2087: keep this file's persisted invoked-property-name evidence current
  // for future rebuilds of OTHER files, regardless of what this rebuild
  // itself needed it for.
  persistInvokedPropertyNamesForFile(db, relPath, ownInvokedPropertyNames);
  persistObjectLiteralSitesForFile(db, relPath, symbols);
  persistInvokedPropertySitesForFile(
    db,
    relPath,
    collectInvokedPropertySites(fileCallsWithCaller, resolveReceiverSites),
  );
  // #2138: same rationale — purgeFileData (called before this function runs)
  // already deleted this file's return_types row; restore it so a later
  // scoped `codegraph build` incremental rebuild can still resolve dispatch
  // through this file's factories/getters.
  persistReturnTypesForFile(db, relPath, symbols);
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
// Chunk-size-keyed statement caches for backfillIncrementalEdgeTechniques'
// technique/confidence-floor UPDATEs below, scoped per db like the
// techniqueBackfillStmtCache/confidenceFloorStmtCache pair in
// stages/build-edges.ts's applyEdgeTechniquesAfterNativeInsert (#1768, #1952).
const incrementalTechniqueBackfillStmtCache = new WeakMap<
  BetterSqlite3Database,
  Map<number, SqliteStatement>
>();
const incrementalConfidenceFloorStmtCache = new WeakMap<
  BetterSqlite3Database,
  Map<number, SqliteStatement>
>();

function backfillIncrementalEdgeTechniques(
  db: BetterSqlite3Database,
  touchedFiles: readonly string[],
): void {
  if (touchedFiles.length === 0) return;
  const CHUNK_SIZE = 500;
  const tx = db.transaction(() => {
    for (let i = 0; i < touchedFiles.length; i += CHUNK_SIZE) {
      const chunk = touchedFiles.slice(i, i + CHUNK_SIZE);
      const chunkSize = chunk.length;
      const techniqueStmt = getOrCreatePerDbChunkStmt(
        incrementalTechniqueBackfillStmtCache,
        db,
        chunkSize,
        (n) =>
          `UPDATE edges SET technique = 'ts-native'
           WHERE kind = 'calls' AND technique IS NULL AND dynamic_kind IS NULL
             AND source_id IN (SELECT id FROM nodes WHERE file IN (${Array.from({ length: n }, () => '?').join(',')}))`,
      );
      techniqueStmt.run(...chunk);
      // Lift resolved ts-native edges below the confidence floor for this
      // chunk, matching the floor lift the full-build native paths apply.
      const confidenceStmt = getOrCreatePerDbChunkStmt(
        incrementalConfidenceFloorStmtCache,
        db,
        chunkSize,
        (n) =>
          `UPDATE edges SET confidence = ?
           WHERE kind = 'calls' AND technique = 'ts-native'
             AND confidence > 0 AND confidence < ?
             AND source_id IN (SELECT id FROM nodes WHERE file IN (${Array.from({ length: n }, () => '?').join(',')}))`,
      );
      confidenceStmt.run(TS_NATIVE_CONFIDENCE_FLOOR, TS_NATIVE_CONFIDENCE_FLOOR, ...chunk);
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
  // #2216: project-wide known-files list, needed for Rust crate::/self::/
  // super:: resolution (#2007) — see getKnownFilesForIncremental's doc comment.
  knownFiles: readonly string[],
  // #2242: real tsconfig/jsconfig aliases — see rebuildReverseDepEdges' param doc.
  aliases: PathAliases,
  // #2077: forwarded to buildCallEdges — see its own param doc.
  maxIterations?: number,
  correlationEnabled = true,
): number {
  // #1967: keep this file's persisted barrel rename table current if it's
  // itself a barrel — independent of the edges rebuilt below.
  persistReexportRenamesForFile(db, relPath, symbols, rootDir, knownFiles, aliases);

  let edgesAdded = buildContainmentEdges(db, stmts, relPath, symbols);
  edgesAdded += rebuildDirContainment(db, stmts, relPath);
  edgesAdded += buildImportEdges(
    stmts,
    relPath,
    symbols,
    rootDir,
    fileNodeRow.id,
    aliases,
    db,
    knownFiles,
  );
  const { importedNames, importedOriginalNames, namespaceImports } = buildImportedNamesMap(
    symbols,
    rootDir,
    relPath,
    aliases,
    db,
    knownFiles,
  );
  edgesAdded += buildCallEdges(
    db,
    stmts,
    relPath,
    symbols,
    fileNodeRow,
    importedNames,
    importedOriginalNames,
    maxIterations,
    namespaceImports,
    correlationEnabled,
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
  knownFiles: readonly string[],
  // #2242: real tsconfig/jsconfig aliases — see rebuildReverseDepEdges' param doc.
  aliases: PathAliases,
): number {
  let edgesAdded = 0;
  for (const [depRelPath, symbols_] of depSymbols) {
    const fileNodeRow_ = stmts.getNodeId.get(depRelPath, 'file', depRelPath, 0);
    if (!fileNodeRow_) continue;
    for (const imp of symbols_.imports) {
      if (imp.reexport) continue;
      const resolvedPath = resolveImportPath(
        path.join(rootDir, depRelPath),
        imp.source,
        rootDir,
        aliases,
        knownFiles,
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
  // #2216: see getKnownFilesForIncremental's doc comment.
  knownFiles: readonly string[],
  // #2242: real tsconfig/jsconfig aliases — see rebuildReverseDepEdges' param doc.
  aliases: PathAliases,
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
    edgesAdded += rebuildReverseDepEdges(
      db,
      rootDir,
      depRelPath,
      symbols_,
      stmts,
      true,
      knownFiles,
      aliases,
      engineOpts.pointsToMaxIterations,
      engineOpts.correlatedPropertyEvidence !== false,
    );
  }
  // Pass 2: add barrel import edges (reexports edges now exist)
  edgesAdded += emitBarrelImportEdgesForReverseDeps(
    db,
    stmts,
    depSymbols,
    rootDir,
    knownFiles,
    aliases,
  );
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

  let chaTargets: ReadonlyArray<ResolvedCandidate> = [];
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
    // Function-scoped key checked before the bare key (#2235 follow-up) —
    // mirrors emitChaCallEdgesForCall (stages/build-edges.ts, full-build path).
    const typeEntry = caller.callerName
      ? (typeMap.get(`${caller.callerName}::${call.receiver}`) ?? typeMap.get(call.receiver))
      : typeMap.get(call.receiver);
    const typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : (typeEntry as { type?: string }).type
      : null;
    if (typeName) {
      chaTargets = resolveChaTargets(typeName, call.name, chaCtx, lookup, relPath);
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
 * Find caller files with an EXISTING CHA/RTA dispatch edge to some OTHER
 * implementor of an interface/base class this rebuild's files just gained or
 * changed an `extends`/`implements` relationship to (#2078).
 *
 * `findReverseDeps` (used to build the reverse-dep cascade above) only finds
 * callers that already have an edge to THIS rebuild's OLD nodes — it cannot
 * discover a caller that dispatches through the *interface type*, not a
 * direct reference, to a sibling implementor elsewhere. If this rebuild adds
 * (or removes) a class implementing that interface, such a caller is never
 * revisited and its dispatch edge to the new implementor is silently missing
 * (or, for a removed implementor, a stale edge from some OTHER unrelated
 * caller to a class that no longer implements the interface would persist —
 * but that half is already handled: `purgeFileData` deletes every edge
 * pointing at a rebuilt file's OLD nodes regardless of which caller holds
 * it, before the file's nodes are re-inserted).
 *
 * A caller "dispatches through the interface" iff it already holds a
 * `technique IN ('cha', 'super-dispatch')` edge to some OTHER known
 * implementor of that same interface — that edge could only have been
 * created by `resolveChaTargets`'s BFS starting from the interface name, so
 * its source file is exactly the caller set this rebuild's implementor-set
 * change needs to reach.
 */
function findChaSiblingCallerFiles(
  db: BetterSqlite3Database,
  chaCtx: ChaContext,
  filesWithSymbols: ReadonlyArray<readonly [string, ExtractorOutput]>,
): string[] {
  const directHeritage = new Set<string>();
  for (const [, symbols] of filesWithSymbols) {
    for (const cls of symbols.classes) {
      if (cls.extends) directHeritage.add(cls.extends);
      if (cls.implements) directHeritage.add(cls.implements);
    }
  }
  if (directHeritage.size === 0) return [];

  // Walk UP the full ancestry from each direct extends/implements name, not
  // just that name itself: a class extending a base that itself implements
  // interface I is ALSO a transitive implementor of I for CHA dispatch
  // purposes, and an existing caller may dispatch via I directly rather than
  // via the (possibly abstract, never-instantiated) intermediate base.
  // `chaCtx.parents` only covers `extends` (single-parent), so this needs
  // its own reverse map covering `implements` too.
  const reverseHeritage = buildReverseHeritageMap(db);
  const touchedInterfaces = new Set<string>(directHeritage);
  const upQueue = [...directHeritage];
  while (upQueue.length > 0) {
    const name = upQueue.shift()!;
    for (const parent of reverseHeritage.get(name) ?? []) {
      if (!touchedInterfaces.has(parent)) {
        touchedInterfaces.add(parent);
        upQueue.push(parent);
      }
    }
  }

  // Walk DOWN from every touched interface/base-class name to every
  // transitively reachable implementor — mirroring `resolveChaTargets`'s own
  // BFS — since an existing caller's edge may point at a sibling several
  // hops below the touched interface, not just a direct child of it.
  const otherImplementors = new Set<string>();
  const downVisited = new Set<string>(touchedInterfaces);
  const downQueue = [...touchedInterfaces];
  while (downQueue.length > 0) {
    const current = downQueue.shift()!;
    for (const child of chaCtx.implementors.get(current) ?? []) {
      if (downVisited.has(child)) continue;
      downVisited.add(child);
      otherImplementors.add(child);
      downQueue.push(child);
    }
  }
  if (otherImplementors.size === 0) return [];

  const knownFiles = new Set(filesWithSymbols.map(([relPath]) => relPath));
  const additional = new Set<string>();
  const stmt = db.prepare(
    `SELECT DISTINCT src.file AS file
     FROM edges e
     JOIN nodes tgt ON e.target_id = tgt.id
     JOIN nodes src ON e.source_id = src.id
     WHERE e.technique IN ('cha', 'super-dispatch')
       AND tgt.kind = 'method'
       AND tgt.name LIKE ? ESCAPE '\\'`,
  );
  for (const cls of otherImplementors) {
    const rows = stmt.all(`${escapeLike(cls)}.%`) as Array<{ file: string }>;
    for (const r of rows) {
      if (!knownFiles.has(r.file)) additional.add(r.file);
    }
  }
  return [...additional];
}

/**
 * Reverse child -> [parent/interface names] map from every `extends` and
 * `implements` edge in the DB, covering BOTH kinds (unlike `ChaContext.parents`,
 * which only tracks `extends` for single-parent super-dispatch resolution) —
 * needed so `findChaSiblingCallerFiles` can walk a rebuilt class's full
 * ancestry upward to find every interface it transitively implements.
 */
function buildReverseHeritageMap(db: BetterSqlite3Database): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT src.name AS child_name, tgt.name AS parent_name
       FROM edges e
       JOIN nodes src ON e.source_id = src.id
       JOIN nodes tgt ON e.target_id = tgt.id
       WHERE e.kind IN ('extends', 'implements')`,
    )
    .all() as Array<{ child_name: string; parent_name: string }>;
  const reverse = new Map<string, string[]>();
  for (const row of rows) {
    let list = reverse.get(row.child_name);
    if (!list) {
      list = [];
      reverse.set(row.child_name, list);
    }
    if (!list.includes(row.parent_name)) list.push(row.parent_name);
  }
  return reverse;
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
 *
 * `findChaSiblingCallerFiles` (#2078) can widen this set with caller files
 * that were never re-parsed by the reverse-dep cascade — those DO need a
 * re-parse (mirroring `parseReverseDep`) since their `calls` array was never
 * held in memory this rebuild.
 */
async function applyChaDispatchPostPass(
  db: BetterSqlite3Database,
  stmts: IncrementalStmts,
  filesWithSymbols: ReadonlyArray<readonly [string, ExtractorOutput]>,
  rootDir: string,
  engineOpts: EngineOpts,
  cache: unknown,
): Promise<number> {
  const chaCtx = buildChaContextFromDb(db);
  if (chaCtx.implementors.size === 0) return 0;

  let allFilesWithSymbols = filesWithSymbols;
  const siblingCallerFiles = findChaSiblingCallerFiles(db, chaCtx, filesWithSymbols);
  if (siblingCallerFiles.length > 0) {
    const extra: Array<readonly [string, ExtractorOutput]> = [];
    for (const relPath of siblingCallerFiles) {
      const symbols = await parseReverseDep(rootDir, relPath, engineOpts, cache);
      if (symbols) extra.push([relPath, symbols]);
    }
    if (extra.length > 0) allFilesWithSymbols = [...filesWithSymbols, ...extra];
  }

  const lookup = makeIncrementalLookup(db, stmts);
  const seenCallEdges = seedChaSeenEdges(
    db,
    allFilesWithSymbols.map(([relPath]) => relPath),
  );

  let edgesAdded = 0;
  for (const [relPath, symbols] of allFilesWithSymbols) {
    const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;
    const typeMap = buildIncrementalTypeMap(symbols);

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
 * Refresh Python entrypoint attribution (#2392) after a single-file rebuild,
 * and reclassify the roles of whatever it changed (#2428).
 *
 * `codegraph watch` previously never wrote `nodes.entrypoint` in any
 * direction — this module is a standalone reimplementation of node/edge
 * persistence that shares no code with the batch pipeline's edge stages, and
 * the column was only ever added to the latter. So during a watch session a
 * newly added guard was never marked, and a guard that was edited away or
 * whose file was deleted left its cross-file target flagged `entry` — still
 * seeding live-code reachability — until the next full build.
 *
 * All of those collapse into "rewrite this file's evidence, then re-project",
 * because the projection reads persisted evidence rather than this rebuild's
 * symbols. That also covers the case where the rebuilt file is the *target*:
 * `purgeFileData` above deleted its node row (and with it the flag), and the
 * untouched guard file's evidence is what puts the flag back on the new row.
 *
 * `pass symbols === null` for a file that no longer exists on disk: the purge
 * already dropped its evidence, so the projection alone does the clearing.
 *
 * Roles are reclassified only for files whose flag actually changed, which is
 * empty on every rebuild in a tree with no Python entrypoints — the projection
 * itself short-circuits on two O(1) probes there.
 */
function refreshEntrypointAttribution(
  db: BetterSqlite3Database,
  rootDir: string,
  relPath: string,
  symbols: ExtractorOutput | null,
): void {
  // `persistEntrypointCalls` skips non-Python files itself — their evidence
  // set is empty in this build and was empty in every earlier one.
  if (symbols) {
    persistEntrypointCalls(db, [[relPath, symbols.calls]]);
  }
  const touchedFiles = projectEntrypointAttribution(db);
  // #2408: pyproject.toml is re-read fresh every rebuild (no evidence table),
  // so this must run on every call regardless of which file changed — a
  // script target's own file rebuilding is exactly the case that needs it.
  // `null` knownFiles falls back to real filesystem checks, which is fine at
  // single-file-rebuild scale.
  touchedFiles.push(...applyPyprojectScriptAttribution(db, rootDir, null));
  if (touchedFiles.length === 0) return;
  // The target's file is frequently not the file being rebuilt, so its cached
  // `nodes.role` would otherwise stay stale at whatever the last full build
  // computed — `entry` for a guard that has since been removed.
  classifyNodeRoles(db, touchedFiles);
}

/**
 * Parse a single file and update the database incrementally.
 *
 * The destructive purge of the file's existing graph data runs only once a
 * full replacement is in hand — after the file has been read AND parsed
 * successfully (#2435). Purging first (as this did before) turned any
 * transient read failure into permanent data loss: every bail-out path
 * returned without re-inserting anything, leaving the file with zero nodes
 * and zero edges while its `file_hashes` row survived still matching the
 * on-disk content, so the next `codegraph build --incremental` classified the
 * file as unchanged and skipped it. The file stayed missing from the graph
 * until someone ran `--no-incremental`. Transient read failures are routine
 * under `codegraph watch`: many editors save via write-to-temp-then-rename,
 * and some briefly change permissions, so the watcher can easily fire while
 * the path is momentarily unreadable.
 *
 * Ordering — not a transaction — is what provides the atomicity here: this
 * function is async (it awaits the parse and the reverse-dep cascade) and
 * better-sqlite3 transactions cannot span an await.
 *
 * This mirrors the discipline the reverse-dep cascade in this same file
 * already follows: `parseReverseDeps` deletes a dep's outgoing edges only
 * after that dep has parsed successfully. The full-build path likewise never
 * purges a file it failed to *read* — change detection reads every candidate's
 * content up front and silently drops the unreadable ones from the changed set
 * (`stages/detect-changes.ts`), so they are never classified as changed. Note
 * that it does purge before parsing, so it does not share this function's
 * protection against a failed *parse* — tracked separately in #2441.
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

  if (!fs.existsSync(filePath)) {
    if (cache) (cache as { remove(p: string): void }).remove(filePath);
    // Purge ancillary tables (incl. embeddings), edges, and nodes in one pass.
    // Embeddings must be purged before nodes — better-sqlite3 enforces foreign
    // keys by default, and `embeddings.node_id` references `nodes.id`. Issue #1176.
    // The file no longer exists, so it has no edges to keep in sync with a
    // hash — `purgeHashes` defaults to true here, unlike the replacement purge
    // below (mirrors the full-build removed-file path in insertNodes.ts, which
    // is likewise unconditional).
    purgeFileData(db, relPath);
    // #2428: the purge above dropped this file's entrypoint evidence, so
    // re-projecting is what clears a target it was attributing — including
    // one declared in a different file, which nothing else in this rebuild
    // touches.
    // #2408 review: this bail-out returns before the common path's cache
    // clear further down, so a long-lived watcher whose cached Python roots
    // predate a pyproject.toml root-config change would resolve this
    // build's script declarations against stale roots — wrongly clearing a
    // still-valid target's attribution because it no longer appears
    // resolvable. Clearing here first keeps every rebuildFile exit path
    // resolving against current roots, not just the common one.
    clearPythonImportRootsCache();
    refreshEntrypointAttribution(db, rootDir, relPath, null);
    return buildDeletionResult(relPath, oldNodes, edgesBefore, oldSymbols, diffSymbols);
  }

  // Read and parse before touching the graph (#2435) — both of these can fail
  // on a file that is still perfectly present and valid in the DB, and there
  // is nothing better to replace it with than what is already there.
  let code: string;
  try {
    code = readFileSafe(filePath);
  } catch (err) {
    warn(`Cannot read ${relPath}: ${(err as Error).message} — graph left unchanged`);
    return null;
  }

  const symbols = await parseFileIncremental(cache, filePath, code, engineOpts);
  if (!symbols) {
    debug(`rebuildFile: no symbols extracted for ${relPath} — graph left unchanged`);
    return null;
  }

  // A full replacement now exists, so swapping it in is safe. Purge ancillary
  // tables (incl. embeddings), edges, and nodes in one pass. Embeddings must be
  // purged before nodes — better-sqlite3 enforces foreign keys by default, and
  // `embeddings.node_id` references `nodes.id`. Issue #1176. `purgeHashes:
  // false` preserves file_hashes for the next incremental build.
  purgeFileData(db, relPath, { purgeHashes: false });

  insertFileNodes(stmts, relPath, symbols);

  const newNodes = stmts.countNodes.get(relPath)?.c || 0;
  const newSymbols: unknown[] = diffSymbols ? stmts.listSymbols.all(relPath) : [];

  const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (!fileNodeRow) {
    // Same invariant, but the parse succeeded — so this file's fresh evidence
    // is known and worth writing, even though no edges get built below.
    // #2408 review: same stale-roots hazard as the deletion path above.
    clearPythonImportRootsCache();
    refreshEntrypointAttribution(db, rootDir, relPath, symbols);
    // Unreachable in practice (`insertFileNodes` just inserted this exact row),
    // but the purge above has already run, so bailing out here leaves the file
    // with nodes and no edges. Drop its `file_hashes` row so the next
    // `codegraph build --incremental` is forced to reprocess the file instead
    // of trusting a hash that no longer describes the graph (#2435) — every
    // other bail-out path returns before the purge and needs no such repair.
    stmts.deleteFileHash.run(relPath);
    return {
      file: relPath,
      nodesAdded: newNodes,
      nodesRemoved: oldNodes,
      edgesAdded: 0,
      edgesBefore,
    };
  }

  // #2216: computed once per rebuild (this file's own node row is already
  // inserted above, so it's included) and threaded through every
  // resolveImportPath call below — see getKnownFilesForIncremental's doc
  // comment for why a single-file incremental rebuild needs this at all.
  const knownFiles = getKnownFilesForIncremental(db, rootDir);
  // #2217: codegraph watch doesn't react to Cargo.toml edits (.toml isn't a
  // watched extension), so a long-running watch session could otherwise keep
  // resolving crate:: paths against a stale Cargo target-override set for
  // its whole lifetime. Clearing here — once per rebuild of any file, not
  // just Rust ones — means the very next Rust file to change (a near-certain
  // companion edit to any real Cargo.toml target change) re-scans fresh.
  clearCargoTargetOverridesCache();
  // Same reasoning for Python (#2387): pyproject.toml isn't watched either,
  // and the layout-derived package roots this also clears go stale as soon as
  // an `__init__.py` is added or removed — which changes where every absolute
  // import in that package tree resolves.
  clearPythonImportRootsCache();
  // Same reasoning again for a dependency's own package.json `exports`
  // field (#2290): unlike the workspace map (refreshed separately by the
  // watcher itself when it detects a package.json change inside the
  // watched tree — see watcher.ts), this cache is cheap to clear (a plain
  // Map#clear, no filesystem re-scan) and can go stale from a change to
  // ANY package's exports field, including a plain node_modules dependency
  // the watcher never observes at all — so it's cleared unconditionally
  // here, once per rebuild of any file, the same way the Cargo/Python
  // caches above are.
  clearExportsCache();
  // #2242: real tsconfig/jsconfig + codegraph-configured aliases, loaded
  // once per rebuild (mirrors knownFiles just above) and threaded through
  // every edge-building call below — a hardcoded empty PathAliases
  // previously dropped every edge kind (not just reexports) for any file
  // whose imports use an alias. engineOpts.aliases carries
  // `.codegraphrc.json`'s own `aliases` field (mirroring pipeline.ts's
  // full-build loadAliases stage, which merges the same on top of
  // tsconfig/jsconfig) since rebuildFile has no PipelineContext to read
  // `ctx.config` from directly.
  const aliases = loadPathAliases(rootDir);
  mergeConfigAliases(aliases, engineOpts.aliases, rootDir);

  let edgesAdded = rebuildEdgesForTargetFile(
    db,
    stmts,
    relPath,
    symbols,
    fileNodeRow,
    rootDir,
    knownFiles,
    aliases,
    engineOpts.pointsToMaxIterations,
    engineOpts.correlatedPropertyEvidence !== false,
  );
  const {
    edgesAdded: cascadeEdges,
    reverseDepsEdgesBefore,
    depSymbols,
  } = await runReverseDepCascade(
    db,
    rootDir,
    reverseDeps,
    stmts,
    engineOpts,
    cache,
    knownFiles,
    aliases,
  );
  edgesAdded += cascadeEdges;

  // Phase 8.5 CHA + RTA dispatch expansion post-pass (#1852) — runs after all
  // of this rebuild's class-hierarchy edges are in the DB (target file +
  // reverse deps), since the DB-driven ChaContext depends on them.
  edgesAdded += await applyChaDispatchPostPass(
    db,
    stmts,
    [[relPath, symbols], ...depSymbols],
    rootDir,
    engineOpts,
    cache,
  );

  // Backfill technique='ts-native' (and the confidence floor) for this
  // rebuild's calls edges — buildCallEdges above inserts edges without a
  // technique value, unlike a full rebuild of either engine, which always
  // tags directly-resolved calls edges 'ts-native' (#1744). Runs after the
  // CHA post-pass, which sets its own non-NULL technique ('cha'/'super-dispatch')
  // at insert time via insertCallEdgeExt — this backfill's `technique IS NULL`
  // filter correctly skips those rows.
  backfillIncrementalEdgeTechniques(db, [relPath, ...reverseDeps]);

  // #2428: must follow every edge-insert path above — the projection reads
  // targets back off the committed `calls` edges, including the ones the
  // reverse-dep cascade just rebuilt.
  refreshEntrypointAttribution(db, rootDir, relPath, symbols);

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
