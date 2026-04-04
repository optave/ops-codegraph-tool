/**
 * Stage: buildEdges
 *
 * Builds import, call, receiver, extends, and implements edges.
 * Uses pre-loaded node lookup maps (N+1 optimization).
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getNodeId } from '../../../../db/index.js';
import { debug } from '../../../../infrastructure/logger.js';
import { loadNative } from '../../../../infrastructure/native.js';
import type {
  BetterSqlite3Database,
  Call,
  ClassRelation,
  ExtractorOutput,
  Import,
  NativeAddon,
  NodeRow,
  TypeMapEntry,
} from '../../../../types.js';
import { computeConfidence } from '../../resolve.js';
import type { PipelineContext } from '../context.js';
import { BUILTIN_RECEIVERS, batchInsertEdges } from '../helpers.js';

import { getResolved, isBarrelFile, resolveBarrelExport } from './resolve-imports.js';

// ── Local types ──────────────────────────────────────────────────────────

type EdgeRowTuple = [number, number, string, number, number];

interface NodeIdStmt {
  get(name: string, kind: string, file: string, line: number): { id: number } | undefined;
}

/** Minimal node shape returned by the SELECT query. */
interface QueryNodeRow {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
}

/** Shape fed to the native buildCallEdges FFI. */
interface NativeFileEntry {
  file: string;
  fileNodeId: number;
  definitions: Array<{ name: string; kind: string; line: number; endLine: number | null }>;
  calls: Call[];
  importedNames: Array<{ name: string; file: string }>;
  classes: ClassRelation[];
  typeMap: Array<{ name: string; typeName: string; confidence: number }>;
}

/** Shape returned by native buildCallEdges. */
interface NativeEdge {
  sourceId: number;
  targetId: number;
  kind: string;
  confidence: number;
  dynamic: number;
}

// ── Node lookup setup ───────────────────────────────────────────────────

function makeGetNodeIdStmt(db: BetterSqlite3Database): NodeIdStmt {
  return {
    get: (name: string, kind: string, file: string, line: number) => {
      const id = getNodeId(db, name, kind, file, line);
      return id != null ? { id } : undefined;
    },
  };
}

function setupNodeLookups(ctx: PipelineContext, allNodes: QueryNodeRow[]): void {
  ctx.nodesByName = new Map();
  for (const node of allNodes) {
    if (!ctx.nodesByName.has(node.name)) ctx.nodesByName.set(node.name, []);
    ctx.nodesByName.get(node.name)!.push(node as unknown as NodeRow);
  }
  ctx.nodesByNameAndFile = new Map();
  for (const node of allNodes) {
    const key = `${node.name}|${node.file}`;
    if (!ctx.nodesByNameAndFile.has(key)) ctx.nodesByNameAndFile.set(key, []);
    ctx.nodesByNameAndFile.get(key)!.push(node as unknown as NodeRow);
  }
}

// ── Import edges ────────────────────────────────────────────────────────

function buildImportEdges(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
): void {
  const { fileSymbols, barrelOnlyFiles, rootDir } = ctx;

  for (const [relPath, symbols] of fileSymbols) {
    const isBarrelOnly = barrelOnlyFiles.has(relPath);
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;
    const fileNodeId = fileNodeRow.id;

    for (const imp of symbols.imports) {
      // Barrel-only files: only emit reexport edges, skip regular imports
      if (isBarrelOnly && !imp.reexport) continue;

      const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
      const targetRow = getNodeIdStmt.get(resolvedPath, 'file', resolvedPath, 0);
      if (!targetRow) continue;

      const edgeKind = imp.reexport
        ? 'reexports'
        : imp.typeOnly
          ? 'imports-type'
          : imp.dynamicImport
            ? 'dynamic-imports'
            : 'imports';
      allEdgeRows.push([fileNodeId, targetRow.id, edgeKind, 1.0, 0]);

      if (!imp.reexport && isBarrelFile(ctx, resolvedPath)) {
        buildBarrelEdges(ctx, imp, resolvedPath, fileNodeId, edgeKind, getNodeIdStmt, allEdgeRows);
      }
    }
  }
}

function buildBarrelEdges(
  ctx: PipelineContext,
  imp: Import,
  resolvedPath: string,
  fileNodeId: number,
  edgeKind: string,
  getNodeIdStmt: NodeIdStmt,
  edgeRows: EdgeRowTuple[],
): void {
  const resolvedSources = new Set<string>();
  for (const name of imp.names) {
    const cleanName = name.replace(/^\*\s+as\s+/, '');
    const actualSource = resolveBarrelExport(ctx, resolvedPath, cleanName);
    if (actualSource && actualSource !== resolvedPath && !resolvedSources.has(actualSource)) {
      resolvedSources.add(actualSource);
      const actualRow = getNodeIdStmt.get(actualSource, 'file', actualSource, 0);
      if (actualRow) {
        const kind =
          edgeKind === 'imports-type'
            ? 'imports-type'
            : edgeKind === 'dynamic-imports'
              ? 'dynamic-imports'
              : 'imports';
        edgeRows.push([fileNodeId, actualRow.id, kind, 0.9, 0]);
      }
    }
  }
}

// ── Import edges (native engine) ────────────────────────────────────────

function buildImportEdgesNative(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  native: NativeAddon,
): void {
  const { fileSymbols, barrelOnlyFiles, rootDir } = ctx;

  // 1. Build per-file input data
  const files: Array<{
    file: string;
    fileNodeId: number;
    isBarrelOnly: boolean;
    imports: Array<{
      source: string;
      names: string[];
      reexport: boolean;
      typeOnly: boolean;
      dynamicImport: boolean;
      wildcardReexport: boolean;
    }>;
    definitionNames: string[];
  }> = [];

  // Collect all file node IDs we'll need (sources + targets)
  const fileNodeIds: Array<{ file: string; nodeId: number }> = [];
  const seenNodeFiles = new Set<string>();

  const addFileNodeId = (relPath: string): { id: number } | undefined => {
    if (seenNodeFiles.has(relPath)) return fileNodeRowCache.get(relPath);
    const row = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (row) {
      seenNodeFiles.add(relPath);
      fileNodeIds.push({ file: relPath, nodeId: row.id });
      fileNodeRowCache.set(relPath, row);
    }
    return row;
  };
  const fileNodeRowCache = new Map<string, { id: number }>();

  // 2. Pre-resolve all imports and build resolved imports array.
  // Keys use forward-slash-normalized rootDir + "/" + relPath to match the Rust
  // lookup format (format!("{}/{}", root_dir.replace('\\', "/"), file)).
  // On Windows, rootDir has backslashes but Rust normalizes them — the JS side
  // must do the same or every resolve key lookup misses (#750).
  const resolvedImports: Array<{ key: string; resolvedPath: string }> = [];
  const fwdRootDir = rootDir.replace(/\\/g, '/');

  for (const [relPath, symbols] of fileSymbols) {
    const fileNodeRow = addFileNodeId(relPath);
    if (!fileNodeRow) continue;

    const importInfos: Array<{
      source: string;
      names: string[];
      reexport: boolean;
      typeOnly: boolean;
      dynamicImport: boolean;
      wildcardReexport: boolean;
    }> = [];

    for (const imp of symbols.imports) {
      // Pre-resolve and register target file node
      const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
      addFileNodeId(resolvedPath);

      // Key matches Rust's format!("{}/{}", root_dir.replace('\\', "/"), file_input.file)
      resolvedImports.push({ key: `${fwdRootDir}/${relPath}|${imp.source}`, resolvedPath });

      importInfos.push({
        source: imp.source,
        names: imp.names,
        reexport: !!imp.reexport,
        typeOnly: !!imp.typeOnly,
        dynamicImport: !!imp.dynamicImport,
        wildcardReexport: !!imp.wildcardReexport,
      });
    }

    files.push({
      file: relPath,
      fileNodeId: fileNodeRow.id,
      isBarrelOnly: barrelOnlyFiles.has(relPath),
      imports: importInfos,
      definitionNames: symbols.definitions.map((d) => d.name),
    });
  }

  // 4. Flatten reexportMap
  const fileReexports: Array<{
    file: string;
    reexports: Array<{
      source: string;
      names: string[];
      wildcardReexport: boolean;
    }>;
  }> = [];
  if (ctx.reexportMap) {
    for (const [file, entries] of ctx.reexportMap) {
      const reexports = (
        entries as Array<{ source: string; names: string[]; wildcardReexport: boolean }>
      ).map((re) => ({
        source: re.source,
        names: re.names,
        wildcardReexport: !!re.wildcardReexport,
      }));
      fileReexports.push({ file, reexports });

      // Register reexport target files for node ID lookup
      for (const re of reexports) {
        addFileNodeId(re.source);
      }
    }
  }

  // 5. Compute barrel file list
  const barrelFiles: string[] = [];
  for (const [relPath] of fileSymbols) {
    if (isBarrelFile(ctx, relPath)) {
      barrelFiles.push(relPath);
    }
  }

  // 6. Call native
  const nativeEdges = native.buildImportEdges!(
    files,
    resolvedImports,
    fileReexports,
    fileNodeIds,
    barrelFiles,
    rootDir,
  ) as NativeEdge[];

  for (const e of nativeEdges) {
    allEdgeRows.push([e.sourceId, e.targetId, e.kind, e.confidence, e.dynamic]);
  }
}

// ── Call edges (native engine) ──────────────────────────────────────────

function buildCallEdgesNative(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  allNodes: QueryNodeRow[],
  native: NativeAddon,
): void {
  const { fileSymbols, barrelOnlyFiles, rootDir } = ctx;
  const nativeFiles: NativeFileEntry[] = [];

  for (const [relPath, symbols] of fileSymbols) {
    if (barrelOnlyFiles.has(relPath)) continue;
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;

    const importedNames = buildImportedNamesForNative(ctx, relPath, symbols, rootDir);
    const typeMap: Array<{ name: string; typeName: string; confidence: number }> =
      symbols.typeMap instanceof Map
        ? [...symbols.typeMap.entries()].map(([name, entry]) => ({
            name,
            typeName: typeof entry === 'string' ? entry : entry.type,
            confidence: typeof entry === 'object' ? entry.confidence : 0.9,
          }))
        : Array.isArray(symbols.typeMap)
          ? (symbols.typeMap as Array<{ name: string; typeName: string; confidence: number }>)
          : [];
    nativeFiles.push({
      file: relPath,
      fileNodeId: fileNodeRow.id,
      definitions: symbols.definitions.map((d) => ({
        name: d.name,
        kind: d.kind,
        line: d.line,
        endLine: d.endLine ?? null,
      })),
      calls: symbols.calls,
      importedNames,
      classes: symbols.classes,
      typeMap,
    });
  }

  const nativeEdges = native.buildCallEdges(nativeFiles, allNodes, [
    ...BUILTIN_RECEIVERS,
  ]) as NativeEdge[];
  for (const e of nativeEdges) {
    allEdgeRows.push([e.sourceId, e.targetId, e.kind, e.confidence, e.dynamic]);
  }
}

function buildImportedNamesForNative(
  ctx: PipelineContext,
  relPath: string,
  symbols: ExtractorOutput,
  rootDir: string,
): Array<{ name: string; file: string }> {
  const importedNames: Array<{ name: string; file: string }> = [];
  const seenNames = new Set<string>();
  for (const imp of symbols.imports) {
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    for (const name of imp.names) {
      const cleanName = name.replace(/^\*\s+as\s+/, '');
      // Don't let dynamic import names shadow static import bindings (see buildImportedNamesMap).
      if (imp.dynamicImport && seenNames.has(cleanName)) continue;
      seenNames.add(cleanName);
      let targetFile = resolvedPath;
      if (isBarrelFile(ctx, resolvedPath)) {
        const actual = resolveBarrelExport(ctx, resolvedPath, cleanName);
        if (actual) targetFile = actual;
      }
      importedNames.push({ name: cleanName, file: targetFile });
    }
  }
  return importedNames;
}

// ── Call edges (JS fallback) ────────────────────────────────────────────

function buildCallEdgesJS(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
): void {
  const { fileSymbols, barrelOnlyFiles, rootDir } = ctx;

  for (const [relPath, symbols] of fileSymbols) {
    if (barrelOnlyFiles.has(relPath)) continue;
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;

    const importedNames = buildImportedNamesMap(ctx, relPath, symbols, rootDir);
    const typeMap: Map<string, TypeMapEntry | string> = symbols.typeMap || new Map();
    const seenCallEdges = new Set<string>();

    buildFileCallEdges(
      ctx,
      relPath,
      symbols,
      fileNodeRow,
      importedNames,
      seenCallEdges,
      getNodeIdStmt,
      allEdgeRows,
      typeMap,
    );
    buildClassHierarchyEdges(ctx, relPath, symbols, allEdgeRows);
  }
}

function buildImportedNamesMap(
  ctx: PipelineContext,
  relPath: string,
  symbols: ExtractorOutput,
  rootDir: string,
): Map<string, string> {
  const importedNames = new Map<string, string>();
  for (const imp of symbols.imports) {
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    for (const name of imp.names) {
      const cleanName = name.replace(/^\*\s+as\s+/, '');
      // Don't let dynamic import names shadow static import bindings.
      // Dynamic imports with destructuring use original export names which can
      // collide with static imports of the same symbol from a different module.
      if (imp.dynamicImport && importedNames.has(cleanName)) continue;
      importedNames.set(cleanName, resolvedPath);
    }
  }
  return importedNames;
}

function findCaller(
  call: Call,
  definitions: ReadonlyArray<{ name: string; kind: string; line: number; endLine?: number | null }>,
  relPath: string,
  getNodeIdStmt: NodeIdStmt,
  fileNodeRow: { id: number },
): { id: number } {
  let caller: { id: number } | null = null;
  let callerSpan = Infinity;
  for (const def of definitions) {
    if (def.line <= call.line) {
      const end = def.endLine || Infinity;
      if (call.line <= end) {
        const span = end - def.line;
        if (span < callerSpan) {
          const row = getNodeIdStmt.get(def.name, def.kind, relPath, def.line);
          if (row) {
            caller = row;
            callerSpan = span;
          }
        }
      }
    }
  }
  return caller || fileNodeRow;
}

function resolveCallTargets(
  ctx: PipelineContext,
  call: Call,
  relPath: string,
  importedNames: Map<string, string>,
  typeMap: Map<string, TypeMapEntry | string>,
): { targets: NodeRow[]; importedFrom: string | undefined } {
  const importedFrom = importedNames.get(call.name);
  let targets: NodeRow[] | undefined;

  if (importedFrom) {
    targets = ctx.nodesByNameAndFile.get(`${call.name}|${importedFrom}`) || [];
    if (targets.length === 0 && isBarrelFile(ctx, importedFrom)) {
      const actualSource = resolveBarrelExport(ctx, importedFrom, call.name);
      if (actualSource) {
        targets = ctx.nodesByNameAndFile.get(`${call.name}|${actualSource}`) || [];
      }
    }
  }

  if (!targets || targets.length === 0) {
    targets = ctx.nodesByNameAndFile.get(`${call.name}|${relPath}`) || [];
    if (targets.length === 0) {
      targets = resolveByMethodOrGlobal(ctx, call, relPath, typeMap);
    }
  }

  if (targets.length > 1) {
    targets.sort((a, b) => {
      const confA = computeConfidence(relPath, a.file, importedFrom ?? null);
      const confB = computeConfidence(relPath, b.file, importedFrom ?? null);
      return confB - confA;
    });
  }

  return { targets, importedFrom };
}

function resolveByMethodOrGlobal(
  ctx: PipelineContext,
  call: Call,
  relPath: string,
  typeMap: Map<string, TypeMapEntry | string>,
): NodeRow[] {
  // Type-aware resolution: translate variable receiver to its declared type
  if (call.receiver && typeMap) {
    const typeEntry = typeMap.get(call.receiver);
    const typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : typeEntry.type
      : null;
    if (typeName) {
      const qualifiedName = `${typeName}.${call.name}`;
      const typed = (ctx.nodesByName.get(qualifiedName) || []).filter((n) => n.kind === 'method');
      if (typed.length > 0) return typed;
    }
  }

  if (
    !call.receiver ||
    call.receiver === 'this' ||
    call.receiver === 'self' ||
    call.receiver === 'super'
  ) {
    return (ctx.nodesByName.get(call.name) || []).filter(
      (n) => computeConfidence(relPath, n.file, null) >= 0.5,
    );
  }
  return [];
}

function buildFileCallEdges(
  ctx: PipelineContext,
  relPath: string,
  symbols: ExtractorOutput,
  fileNodeRow: { id: number },
  importedNames: Map<string, string>,
  seenCallEdges: Set<string>,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  typeMap: Map<string, TypeMapEntry | string>,
): void {
  for (const call of symbols.calls) {
    if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;

    const caller = findCaller(call, symbols.definitions, relPath, getNodeIdStmt, fileNodeRow);
    const isDynamic: number = call.dynamic ? 1 : 0;
    const { targets, importedFrom } = resolveCallTargets(
      ctx,
      call,
      relPath,
      importedNames,
      typeMap,
    );

    for (const t of targets) {
      const edgeKey = `${caller.id}|${t.id}`;
      if (t.id !== caller.id && !seenCallEdges.has(edgeKey)) {
        seenCallEdges.add(edgeKey);
        const confidence = computeConfidence(relPath, t.file, importedFrom ?? null);
        allEdgeRows.push([caller.id, t.id, 'calls', confidence, isDynamic]);
      }
    }

    // Receiver edge
    if (
      call.receiver &&
      !BUILTIN_RECEIVERS.has(call.receiver) &&
      call.receiver !== 'this' &&
      call.receiver !== 'self' &&
      call.receiver !== 'super'
    ) {
      buildReceiverEdge(ctx, call, caller, relPath, seenCallEdges, allEdgeRows, typeMap);
    }
  }
}

function buildReceiverEdge(
  ctx: PipelineContext,
  call: Call,
  caller: { id: number },
  relPath: string,
  seenCallEdges: Set<string>,
  allEdgeRows: EdgeRowTuple[],
  typeMap: Map<string, TypeMapEntry | string>,
): void {
  const receiverKinds = new Set(['class', 'struct', 'interface', 'type', 'module']);
  const typeEntry = typeMap?.get(call.receiver!);
  const typeName = typeEntry ? (typeof typeEntry === 'string' ? typeEntry : typeEntry.type) : null;
  const typeConfidence = typeEntry && typeof typeEntry === 'object' ? typeEntry.confidence : null;
  const effectiveReceiver = typeName || call.receiver!;
  const samefile = ctx.nodesByNameAndFile.get(`${effectiveReceiver}|${relPath}`) || [];
  const candidates = samefile.length > 0 ? samefile : ctx.nodesByName.get(effectiveReceiver) || [];
  const receiverNodes = candidates.filter((n) => receiverKinds.has(n.kind));
  if (receiverNodes.length > 0 && caller) {
    const recvTarget = receiverNodes[0]!;
    const recvKey = `recv|${caller.id}|${recvTarget.id}`;
    if (!seenCallEdges.has(recvKey)) {
      seenCallEdges.add(recvKey);
      // Use type source confidence when available, otherwise 0.7 for untyped receiver
      const confidence = typeConfidence ?? (typeName ? 0.9 : 0.7);
      allEdgeRows.push([caller.id, recvTarget.id, 'receiver', confidence, 0]);
    }
  }
}

// ── Class hierarchy edges ───────────────────────────────────────────────

const HIERARCHY_SOURCE_KINDS = new Set(['class', 'struct', 'record', 'enum']);
const EXTENDS_TARGET_KINDS = new Set(['class', 'struct', 'trait', 'record']);
const IMPLEMENTS_TARGET_KINDS = new Set(['interface', 'trait', 'class']);

function buildClassHierarchyEdges(
  ctx: PipelineContext,
  relPath: string,
  symbols: ExtractorOutput,
  allEdgeRows: EdgeRowTuple[],
): void {
  for (const cls of symbols.classes) {
    if (cls.extends) {
      const sourceRow = (ctx.nodesByNameAndFile.get(`${cls.name}|${relPath}`) || []).find((n) =>
        HIERARCHY_SOURCE_KINDS.has(n.kind),
      );
      const targetRows = (ctx.nodesByName.get(cls.extends) || []).filter((n) =>
        EXTENDS_TARGET_KINDS.has(n.kind),
      );
      if (sourceRow) {
        for (const t of targetRows) {
          allEdgeRows.push([sourceRow.id, t.id, 'extends', 1.0, 0]);
        }
      }
    }

    if (cls.implements) {
      const sourceRow = (ctx.nodesByNameAndFile.get(`${cls.name}|${relPath}`) || []).find((n) =>
        HIERARCHY_SOURCE_KINDS.has(n.kind),
      );
      const targetRows = (ctx.nodesByName.get(cls.implements) || []).filter((n) =>
        IMPLEMENTS_TARGET_KINDS.has(n.kind),
      );
      if (sourceRow) {
        for (const t of targetRows) {
          allEdgeRows.push([sourceRow.id, t.id, 'implements', 1.0, 0]);
        }
      }
    }
  }
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * For small incremental builds (≤5 changed files on a large codebase), scope
 * the node loading query to only files that are relevant: changed files +
 * their import targets. Falls back to loading ALL nodes for full builds or
 * larger incremental changes.
 */
function loadNodes(ctx: PipelineContext): { rows: QueryNodeRow[]; scoped: boolean } {
  const { db, fileSymbols, isFullBuild, batchResolved } = ctx;
  const nodeKindFilter = `kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant')`;

  // Gate: only scope for small incremental on large codebases
  if (!isFullBuild && fileSymbols.size <= 5) {
    const existingFileCount = (
      db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get() as { c: number }
    ).c;
    if (existingFileCount > 20) {
      // Collect relevant files: changed files + their import targets
      const relevantFiles = new Set<string>(fileSymbols.keys());
      if (batchResolved) {
        for (const resolvedPath of batchResolved.values()) {
          relevantFiles.add(resolvedPath);
        }
      }
      // Also add barrel-only files
      for (const barrelPath of ctx.barrelOnlyFiles) {
        relevantFiles.add(barrelPath);
      }

      const placeholders = [...relevantFiles].map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT id, name, kind, file, line FROM nodes WHERE ${nodeKindFilter} AND file IN (${placeholders})`,
        )
        .all(...relevantFiles) as QueryNodeRow[];
      return { rows, scoped: true };
    }
  }

  const rows = db
    .prepare(`SELECT id, name, kind, file, line FROM nodes WHERE ${nodeKindFilter}`)
    .all() as QueryNodeRow[];
  return { rows, scoped: false };
}

/**
 * For scoped node loading, patch nodesByName.get with a lazy SQL fallback
 * so global name-only lookups (resolveByMethodOrGlobal)
 * can still find nodes outside the scoped set.
 */
function addLazyFallback(ctx: PipelineContext, scopedLoad: boolean): void {
  if (!scopedLoad) return;
  const { db } = ctx;
  const fallbackStmt = db.prepare(
    `SELECT id, name, kind, file, line FROM nodes WHERE name = ? AND kind != 'file'`,
  );
  const originalGet = ctx.nodesByName.get.bind(ctx.nodesByName);
  ctx.nodesByName.get = (name: string) => {
    const result = originalGet(name);
    if (result !== undefined) return result;
    const rows = fallbackStmt.all(name) as unknown as NodeRow[];
    if (rows.length > 0) {
      ctx.nodesByName.set(name, rows);
      return rows;
    }
    return undefined;
  };
}

export async function buildEdges(ctx: PipelineContext): Promise<void> {
  const { db, engineName } = ctx;

  const getNodeIdStmt = makeGetNodeIdStmt(db);

  const { rows: allNodesBefore, scoped: scopedLoad } = loadNodes(ctx);
  setupNodeLookups(ctx, allNodesBefore);
  addLazyFallback(ctx, scopedLoad);

  const t0 = performance.now();
  const native = engineName === 'native' ? loadNative() : null;

  // Phase 1: Compute edges inside a better-sqlite3 transaction.
  // Barrel-edge deletion lives here so that the JS path (which also inserts
  // edges in this transaction) keeps deletion + insertion atomic.
  // When using the native rusqlite path, insertion happens in Phase 2 on a
  // separate connection — a crash between Phase 1 and Phase 2 would leave
  // barrel edges missing until the next incremental rebuild re-creates them.
  const allEdgeRows: EdgeRowTuple[] = [];
  const computeEdgesTx = db.transaction(() => {
    if (ctx.barrelOnlyFiles.size > 0) {
      const deleteOutgoingEdges = db.prepare(
        'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
      );
      for (const relPath of ctx.barrelOnlyFiles) {
        deleteOutgoingEdges.run(relPath);
      }
    }

    // Skip native import-edge path for small incremental builds (≤3 files):
    // napi-rs marshaling overhead exceeds computation savings.
    const useNativeImportEdges =
      native?.buildImportEdges && (ctx.isFullBuild || ctx.fileSymbols.size > 3);
    if (useNativeImportEdges) {
      const beforeLen = allEdgeRows.length;
      buildImportEdgesNative(ctx, getNodeIdStmt, allEdgeRows, native!);
      // Fallback: if native produced 0 import edges but there are imports to
      // process, the native binary may have a key-format mismatch (e.g. Windows
      // path separators — #750).  Retry with the JS implementation.
      // NOTE: This also fires for codebases where every import targets an
      // external package (npm deps) that the resolver intentionally skips.
      // In that case the JS path resolves zero edges too, so the only cost
      // is the redundant JS traversal — no correctness impact.
      const hasImports = [...ctx.fileSymbols.values()].some((s) => s.imports.length > 0);
      if (allEdgeRows.length === beforeLen && hasImports) {
        debug('Native buildImportEdges produced 0 edges — falling back to JS');
        buildImportEdges(ctx, getNodeIdStmt, allEdgeRows);
      }
    } else {
      buildImportEdges(ctx, getNodeIdStmt, allEdgeRows);
    }

    // Skip native call-edge path for small incremental builds (≤3 files):
    // napi-rs marshaling overhead for allNodes exceeds computation savings.
    const useNativeCallEdges =
      native?.buildCallEdges && (ctx.isFullBuild || ctx.fileSymbols.size > 3);
    if (useNativeCallEdges) {
      buildCallEdgesNative(ctx, getNodeIdStmt, allEdgeRows, allNodesBefore, native!);
    } else {
      buildCallEdgesJS(ctx, getNodeIdStmt, allEdgeRows);
    }

    // When using native edge insert, skip JS insert here — do it after tx commits.
    // Otherwise insert edges within this transaction for atomicity.
    const useNativeEdgeInsert = ctx.engineName === 'native' && !!ctx.nativeDb?.bulkInsertEdges;
    if (!useNativeEdgeInsert) {
      batchInsertEdges(db, allEdgeRows);
    }
  });
  computeEdgesTx();

  // Phase 2: Native rusqlite bulk insert (outside better-sqlite3 transaction
  // to avoid SQLITE_BUSY contention). Uses NativeDatabase persistent connection.
  // Standalone napi functions were removed in 6.17.
  if (ctx.engineName === 'native' && ctx.nativeDb?.bulkInsertEdges && allEdgeRows.length > 0) {
    const nativeEdges = allEdgeRows.map((r) => ({
      sourceId: r[0],
      targetId: r[1],
      kind: r[2],
      confidence: r[3],
      dynamic: r[4],
    }));
    const ok = ctx.nativeDb.bulkInsertEdges(nativeEdges);
    if (!ok) {
      debug('Native bulkInsertEdges failed — falling back to JS batchInsertEdges');
      batchInsertEdges(ctx.db, allEdgeRows);
    }
  }

  ctx.timing.edgesMs = performance.now() - t0;
}
