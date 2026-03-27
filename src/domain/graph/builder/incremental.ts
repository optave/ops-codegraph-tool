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
import { bulkNodeIdsByFile } from '../../../db/index.js';
import { warn } from '../../../infrastructure/logger.js';
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
import { BUILTIN_RECEIVERS, readFileSafe } from './helpers.js';

// ── Local types ─────────────────────────────────────────────────────────

export interface IncrementalStmts {
  insertNode: { run: (...params: unknown[]) => unknown };
  insertEdge: { run: (...params: unknown[]) => unknown };
  getNodeId: { get: (...params: unknown[]) => { id: number } | undefined };
  deleteEdgesForFile: { run: (...params: unknown[]) => unknown };
  deleteNodes: { run: (...params: unknown[]) => unknown };
  countNodes: { get: (...params: unknown[]) => { c: number } | undefined };
  listSymbols: { all: (...params: unknown[]) => unknown[] };
  findNodeInFile: { all: (...params: unknown[]) => unknown[] };
  findNodeByName: { all: (...params: unknown[]) => unknown[] };
}

interface RebuildResult {
  file: string;
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
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
let _deleteOutEdgesStmt: SqliteStatement | null = null;

function getRevDepStmts(db: BetterSqlite3Database): {
  findRevDepsStmt: SqliteStatement;
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
    _deleteOutEdgesStmt = db.prepare(
      'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    );
  }
  return {
    findRevDepsStmt: _findRevDepsStmt!,
    deleteOutEdgesStmt: _deleteOutEdgesStmt!,
  };
}

function findReverseDeps(db: BetterSqlite3Database, relPath: string): string[] {
  const { findRevDepsStmt } = getRevDepStmts(db);
  return (findRevDepsStmt.all(relPath, relPath) as Array<{ file: string }>).map((r) => r.file);
}

function deleteOutgoingEdges(db: BetterSqlite3Database, relPath: string): void {
  const { deleteOutEdgesStmt } = getRevDepStmts(db);
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
  } catch {
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
  const importedNames = buildImportedNamesMap(symbols, rootDir, depRelPath, aliases);
  edgesAdded += buildCallEdges(stmts, depRelPath, symbols, fileNodeRow, importedNames);
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

// ── Ancillary table cleanup ────────────────────────────────────────────

function purgeAncillaryData(db: BetterSqlite3Database, relPath: string): void {
  const tryExec = (sql: string, ...args: string[]): void => {
    try {
      db.prepare(sql).run(...args);
    } catch (err: unknown) {
      if (!(err as Error | undefined)?.message?.includes('no such table')) throw err;
    }
  };
  tryExec(
    'DELETE FROM function_complexity WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM node_metrics WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM cfg_edges WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM cfg_blocks WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?) OR target_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
    relPath,
  );
  tryExec('DELETE FROM ast_nodes WHERE file = ?', relPath);
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
  for (const name of imp.names) {
    const cleanName = name.replace(/^\*\s+as\s+/, '');
    const actualSource = resolveBarrelTarget(db, resolvedPath, cleanName);
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
    const resolvedPath = resolveImportPath(
      path.join(rootDir, relPath),
      imp.source,
      rootDir,
      aliases,
    );
    const targetRow = stmts.getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
    if (targetRow) {
      const edgeKind = imp.reexport ? 'reexports' : imp.typeOnly ? 'imports-type' : 'imports';
      stmts.insertEdge.run(fileNodeId, targetRow.id, edgeKind, 1.0, 0);
      edgesAdded++;

      // Barrel resolution: create edges through re-export chains
      if (!imp.reexport && db) {
        edgesAdded += resolveBarrelImportEdges(db, stmts, fileNodeId, resolvedPath, imp);
      }
    }
  }
  return edgesAdded;
}

function buildImportedNamesMap(
  symbols: ExtractorOutput,
  rootDir: string,
  relPath: string,
  aliases: PathAliases,
): Map<string, string> {
  const importedNames = new Map<string, string>();
  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportPath(
      path.join(rootDir, relPath),
      imp.source,
      rootDir,
      aliases,
    );
    for (const name of imp.names) {
      importedNames.set(name.replace(/^\*\s+as\s+/, ''), resolvedPath);
    }
  }
  return importedNames;
}

// ── Call edge building ──────────────────────────────────────────────────

function findCaller(
  call: ExtractorOutput['calls'][number],
  definitions: ExtractorOutput['definitions'],
  relPath: string,
  stmts: IncrementalStmts,
): { id: number } | null {
  let caller: { id: number } | null = null;
  let callerSpan = Infinity;
  for (const def of definitions) {
    if (def.line <= call.line) {
      const end = def.endLine || Infinity;
      if (call.line <= end) {
        const span = end - def.line;
        if (span < callerSpan) {
          const row = stmts.getNodeId.get(def.name, def.kind, relPath, def.line);
          if (row) {
            caller = row;
            callerSpan = span;
          }
        }
      }
    }
  }
  return caller;
}

function resolveCallTargets(
  stmts: IncrementalStmts,
  call: ExtractorOutput['calls'][number],
  relPath: string,
  importedNames: Map<string, string>,
  typeMap: Map<string, unknown>,
): { targets: Array<{ id: number; file: string }>; importedFrom: string | undefined } {
  const importedFrom = importedNames.get(call.name);
  let targets: Array<{ id: number; file: string }> | undefined;
  if (importedFrom) {
    targets = stmts.findNodeInFile.all(call.name, importedFrom) as Array<{
      id: number;
      file: string;
    }>;
  }
  if (!targets || targets.length === 0) {
    targets = stmts.findNodeInFile.all(call.name, relPath) as Array<{ id: number; file: string }>;
    if (targets.length === 0) {
      targets = stmts.findNodeByName.all(call.name) as Array<{ id: number; file: string }>;
    }
  }
  // Type-aware resolution: translate variable receiver to declared type
  if ((!targets || targets.length === 0) && call.receiver && typeMap) {
    const typeEntry = typeMap.get(call.receiver);
    const typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : (typeEntry as { type?: string }).type
      : null;
    if (typeName) {
      const qualified = `${typeName}.${call.name}`;
      targets = stmts.findNodeByName.all(qualified) as Array<{ id: number; file: string }>;
    }
  }
  return { targets: targets ?? [], importedFrom };
}

function buildCallEdges(
  stmts: IncrementalStmts,
  relPath: string,
  symbols: ExtractorOutput,
  fileNodeRow: { id: number },
  importedNames: Map<string, string>,
): number {
  const rawTM: unknown = symbols.typeMap;
  const typeMap: Map<string, unknown> =
    rawTM instanceof Map
      ? rawTM
      : Array.isArray(rawTM) && rawTM.length > 0
        ? new Map(
            (rawTM as Array<{ name: string; typeName?: string; type?: string }>).map((e) => [
              e.name,
              e.typeName ?? e.type ?? null,
            ]),
          )
        : new Map();
  let edgesAdded = 0;
  for (const call of symbols.calls) {
    if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;

    const caller = findCaller(call, symbols.definitions, relPath, stmts) || fileNodeRow;
    const { targets, importedFrom } = resolveCallTargets(
      stmts,
      call,
      relPath,
      importedNames,
      typeMap,
    );

    for (const t of targets) {
      if (t.id !== caller.id) {
        const confidence = computeConfidence(relPath, t.file, importedFrom ?? null);
        stmts.insertEdge.run(caller.id, t.id, 'calls', confidence, call.dynamic ? 1 : 0);
        edgesAdded++;
      }
    }
  }
  return edgesAdded;
}

// ── Main entry point ────────────────────────────────────────────────────

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
  const oldSymbols: unknown[] = diffSymbols ? stmts.listSymbols.all(relPath) : [];

  // Find reverse-deps BEFORE purging (edges still reference the old nodes)
  const reverseDeps = findReverseDeps(db, relPath);

  // Purge ancillary tables, then edges, then nodes
  purgeAncillaryData(db, relPath);
  stmts.deleteEdgesForFile.run(relPath);
  stmts.deleteNodes.run(relPath);

  if (!fs.existsSync(filePath)) {
    if (cache) (cache as { remove(p: string): void }).remove(filePath);
    const symbolDiff = diffSymbols ? diffSymbols(oldSymbols, []) : null;
    return {
      file: relPath,
      nodesAdded: 0,
      nodesRemoved: oldNodes,
      edgesAdded: 0,
      deleted: true,
      event: 'deleted',
      symbolDiff,
      nodesBefore: oldNodes,
      nodesAfter: 0,
    };
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
    return { file: relPath, nodesAdded: newNodes, nodesRemoved: oldNodes, edgesAdded: 0 };

  const aliases: PathAliases = { baseUrl: null, paths: {} };

  let edgesAdded = buildContainmentEdges(db, stmts, relPath, symbols);
  edgesAdded += rebuildDirContainment(db, stmts, relPath);
  edgesAdded += buildImportEdges(stmts, relPath, symbols, rootDir, fileNodeRow.id, aliases, db);
  const importedNames = buildImportedNamesMap(symbols, rootDir, relPath, aliases);
  edgesAdded += buildCallEdges(stmts, relPath, symbols, fileNodeRow, importedNames);

  // Cascade: rebuild outgoing edges for reverse-dep files.
  // Two-pass approach: first rebuild direct edges (creating reexports edges for barrels),
  // then add barrel import edges (which need reexports edges to exist for resolution).
  const depSymbols = new Map<string, ExtractorOutput>();
  for (const depRelPath of reverseDeps) {
    const symbols_ = await parseReverseDep(rootDir, depRelPath, engineOpts, cache);
    if (symbols_) {
      deleteOutgoingEdges(db, depRelPath);
      depSymbols.set(depRelPath, symbols_);
    }
  }
  // Pass 1: direct edges only (no barrel resolution) — creates reexports edges
  for (const [depRelPath, symbols_] of depSymbols) {
    edgesAdded += rebuildReverseDepEdges(db, rootDir, depRelPath, symbols_, stmts, true);
  }
  // Pass 2: add barrel import edges (reexports edges now exist)
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

  const symbolDiff = diffSymbols ? diffSymbols(oldSymbols, newSymbols) : null;
  const event = oldNodes === 0 ? 'added' : 'modified';

  return {
    file: relPath,
    nodesAdded: newNodes,
    nodesRemoved: oldNodes,
    edgesAdded,
    deleted: false,
    event,
    symbolDiff,
    nodesBefore: oldNodes,
    nodesAfter: newNodes,
  };
}
