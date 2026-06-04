/**
 * Stage: buildEdges
 *
 * Builds import, call, receiver, extends, and implements edges.
 * Uses pre-loaded node lookup maps (N+1 optimization).
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getNodeId } from '../../../../db/index.js';
import { setTypeMapEntry } from '../../../../extractors/helpers.js';
import { PROPAGATION_HOP_PENALTY } from '../../../../extractors/javascript.js';
import { debug } from '../../../../infrastructure/logger.js';
import { loadNative } from '../../../../infrastructure/native.js';
import type {
  BetterSqlite3Database,
  Call,
  ClassRelation,
  Definition,
  ExtractorOutput,
  Import,
  NativeAddon,
  NodeRow,
  TypeMapEntry,
} from '../../../../types.js';
import { computeConfidence } from '../../resolve.js';
import type { PointsToMap } from '../../resolver/points-to.js';
import { buildPointsToMap, resolveViaPointsTo } from '../../resolver/points-to.js';
import { enrichTypeMapWithTsc } from '../../resolver/ts-resolver.js';
import {
  type CallNodeLookup,
  findCaller,
  resolveCallTargets,
  resolveReceiverEdge,
} from '../call-resolver.js';
import type { PipelineContext } from '../context.js';
import { BUILTIN_RECEIVERS, batchInsertEdges } from '../helpers.js';
import { getResolved, isBarrelFile, resolveBarrelExportCached } from './resolve-imports.js';

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
  /** Phase 8.3: function-reference bindings for pts analysis. */
  fnRefBindings?: Array<{ lhs: string; rhs: string; rhsReceiver?: string }>;
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

/** Pick the edge kind for an import statement based on its modifiers. */
function importEdgeKind(imp: Import): string {
  if (imp.reexport) return 'reexports';
  if (imp.typeOnly) return 'imports-type';
  if (imp.dynamicImport) return 'dynamic-imports';
  return 'imports';
}

/**
 * For a `import type` statement, emit symbol-level `imports-type` edges so
 * the target symbols get fan-in credit and aren't classified as dead code.
 */
function emitTypeOnlySymbolEdges(
  ctx: PipelineContext,
  imp: Import,
  resolvedPath: string,
  fileNodeId: number,
  allEdgeRows: EdgeRowTuple[],
): void {
  if (!ctx.nodesByNameAndFile) return;
  for (const name of imp.names) {
    const cleanName = name.replace(/^\*\s+as\s+/, '');
    let targetFile = resolvedPath;
    if (isBarrelFile(ctx, resolvedPath)) {
      const actual = resolveBarrelExportCached(ctx, resolvedPath, cleanName);
      if (actual) targetFile = actual;
    }
    const candidates = ctx.nodesByNameAndFile.get(`${cleanName}|${targetFile}`);
    if (candidates && candidates.length > 0) {
      allEdgeRows.push([fileNodeId, candidates[0]!.id, 'imports-type', 1.0, 0]);
    }
  }
}

/**
 * Process a single import statement and emit all resulting edges (file→file,
 * type-only symbol-level, and barrel re-export targets).
 */
function emitEdgesForImport(
  ctx: PipelineContext,
  imp: Import,
  fileNodeId: number,
  relPath: string,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
): void {
  const resolvedPath = getResolved(ctx, path.join(ctx.rootDir, relPath), imp.source);
  const targetRow = getNodeIdStmt.get(resolvedPath, 'file', resolvedPath, 0);
  if (!targetRow) return;

  const edgeKind = importEdgeKind(imp);
  allEdgeRows.push([fileNodeId, targetRow.id, edgeKind, 1.0, 0]);

  if (imp.typeOnly) {
    emitTypeOnlySymbolEdges(ctx, imp, resolvedPath, fileNodeId, allEdgeRows);
  }

  if (!imp.reexport && isBarrelFile(ctx, resolvedPath)) {
    buildBarrelEdges(ctx, imp, resolvedPath, fileNodeId, edgeKind, getNodeIdStmt, allEdgeRows);
  }
}

function buildImportEdges(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
): void {
  const { fileSymbols, barrelOnlyFiles } = ctx;

  for (const [relPath, symbols] of fileSymbols) {
    const isBarrelOnly = barrelOnlyFiles.has(relPath);
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;
    const fileNodeId = fileNodeRow.id;

    for (const imp of symbols.imports) {
      // Barrel-only files: only emit reexport edges, skip regular imports
      if (isBarrelOnly && !imp.reexport) continue;
      emitEdgesForImport(ctx, imp, fileNodeId, relPath, getNodeIdStmt, allEdgeRows);
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
    const actualSource = resolveBarrelExportCached(ctx, resolvedPath, cleanName);
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

/** Native FFI input shape for a single import statement. */
interface NativeImportInfo {
  source: string;
  names: string[];
  reexport: boolean;
  typeOnly: boolean;
  dynamicImport: boolean;
  wildcardReexport: boolean;
}

/** Native FFI input shape for a single file. */
interface NativeFileInput {
  file: string;
  fileNodeId: number;
  isBarrelOnly: boolean;
  imports: NativeImportInfo[];
  definitionNames: string[];
}

/** Native FFI input shape for re-exports of a single file. */
interface NativeReexportInput {
  file: string;
  reexports: Array<{ source: string; names: string[]; wildcardReexport: boolean }>;
}

/** Lazily-resolving cache of file-node rows for the native input arrays. */
interface FileNodeIdRegistry {
  ids: Array<{ file: string; nodeId: number }>;
  add(relPath: string): { id: number } | undefined;
}

function createFileNodeIdRegistry(getNodeIdStmt: NodeIdStmt): FileNodeIdRegistry {
  const ids: Array<{ file: string; nodeId: number }> = [];
  const seen = new Set<string>();
  const cache = new Map<string, { id: number }>();
  return {
    ids,
    add(relPath: string) {
      if (seen.has(relPath)) return cache.get(relPath);
      const row = getNodeIdStmt.get(relPath, 'file', relPath, 0);
      if (row) {
        seen.add(relPath);
        ids.push({ file: relPath, nodeId: row.id });
        cache.set(relPath, row);
      }
      return row;
    },
  };
}

function toNativeImportInfo(imp: Import): NativeImportInfo {
  return {
    source: imp.source,
    names: imp.names,
    reexport: !!imp.reexport,
    typeOnly: !!imp.typeOnly,
    dynamicImport: !!imp.dynamicImport,
    wildcardReexport: !!imp.wildcardReexport,
  };
}

/**
 * Pre-resolve every import for the given files, registering each resolved
 * target with the registry so the native side has full node-id coverage.
 *
 * Resolved-import keys use forward-slash-normalized rootDir + "/" + relPath to
 * match the Rust lookup format. On Windows, rootDir has backslashes but Rust
 * normalizes them — the JS side must do the same or every key lookup misses
 * (#750).
 */
function buildNativeFileInputs(
  ctx: PipelineContext,
  registry: FileNodeIdRegistry,
): {
  files: NativeFileInput[];
  resolvedImports: Array<{ key: string; resolvedPath: string }>;
} {
  const { fileSymbols, barrelOnlyFiles, rootDir } = ctx;
  const fwdRootDir = rootDir.replace(/\\/g, '/');
  const files: NativeFileInput[] = [];
  const resolvedImports: Array<{ key: string; resolvedPath: string }> = [];

  for (const [relPath, symbols] of fileSymbols) {
    const fileNodeRow = registry.add(relPath);
    if (!fileNodeRow) continue;

    const importInfos: NativeImportInfo[] = [];
    for (const imp of symbols.imports) {
      const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
      registry.add(resolvedPath);
      resolvedImports.push({ key: `${fwdRootDir}/${relPath}|${imp.source}`, resolvedPath });
      importInfos.push(toNativeImportInfo(imp));
    }

    files.push({
      file: relPath,
      fileNodeId: fileNodeRow.id,
      isBarrelOnly: barrelOnlyFiles.has(relPath),
      imports: importInfos,
      definitionNames: symbols.definitions.map((d) => d.name),
    });
  }
  return { files, resolvedImports };
}

/** Flatten `ctx.reexportMap` into the array shape the native side expects. */
function buildNativeReexports(
  ctx: PipelineContext,
  registry: FileNodeIdRegistry,
): NativeReexportInput[] {
  const fileReexports: NativeReexportInput[] = [];
  if (!ctx.reexportMap) return fileReexports;

  for (const [file, entries] of ctx.reexportMap) {
    const reexports = (
      entries as Array<{ source: string; names: string[]; wildcardReexport: boolean }>
    ).map((re) => ({
      source: re.source,
      names: re.names,
      wildcardReexport: !!re.wildcardReexport,
    }));
    fileReexports.push({ file, reexports });

    for (const re of reexports) {
      registry.add(re.source);
    }
  }
  return fileReexports;
}

function collectBarrelFiles(ctx: PipelineContext): string[] {
  const barrelFiles: string[] = [];
  for (const [relPath] of ctx.fileSymbols) {
    if (isBarrelFile(ctx, relPath)) barrelFiles.push(relPath);
  }
  return barrelFiles;
}

function collectSymbolNodes(
  ctx: PipelineContext,
): Array<{ name: string; file: string; nodeId: number }> {
  const symbolNodes: Array<{ name: string; file: string; nodeId: number }> = [];
  if (!ctx.nodesByNameAndFile) return symbolNodes;
  for (const [key, nodes] of ctx.nodesByNameAndFile) {
    if (nodes.length === 0) continue;
    const [name, file] = key.split('|');
    symbolNodes.push({ name: name!, file: file!, nodeId: nodes[0]!.id });
  }
  return symbolNodes;
}

function buildImportEdgesNative(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  native: NativeAddon,
): void {
  const registry = createFileNodeIdRegistry(getNodeIdStmt);

  const { files, resolvedImports } = buildNativeFileInputs(ctx, registry);
  const fileReexports = buildNativeReexports(ctx, registry);
  const barrelFiles = collectBarrelFiles(ctx);
  const symbolNodes = collectSymbolNodes(ctx);

  const nativeEdges = native.buildImportEdges!(
    files,
    resolvedImports,
    fileReexports,
    registry.ids,
    barrelFiles,
    ctx.rootDir,
    symbolNodes,
  ) as NativeEdge[];

  for (const e of nativeEdges) {
    allEdgeRows.push([e.sourceId, e.targetId, e.kind, e.confidence, e.dynamic]);
  }
}

// ── Phase 8.2: Cross-file return-type propagation ───────────────────────

/**
 * Augment each file's typeMap with return types from imported functions.
 *
 * The per-file extractor already resolves same-file call assignments (intra-file
 * propagation). This function handles the cross-file case: when a file imports a
 * function from another file and assigns its return value to a variable, we look up
 * the callee's return type in the source file's returnTypeMap and inject it.
 *
 * Called once before call-edge building so both the native and JS paths benefit.
 */
function propagateReturnTypesAcrossFiles(
  fileSymbols: Map<string, ExtractorOutput>,
  ctx: PipelineContext,
  rootDir: string,
): void {
  // Index: filePath → per-file return-type map
  const returnTypeIndex = new Map<string, Map<string, TypeMapEntry>>();
  for (const [relPath, symbols] of fileSymbols) {
    if (symbols.returnTypeMap?.size) returnTypeIndex.set(relPath, symbols.returnTypeMap);
  }
  if (returnTypeIndex.size === 0) return;

  // Flat global map for qualified method lookups (TypeName.methodName → entry).
  // Conflicts resolved by keeping the highest-confidence entry.
  const globalReturnTypeMap = new Map<string, TypeMapEntry>();
  for (const rtm of returnTypeIndex.values()) {
    for (const [name, entry] of rtm) {
      const existing = globalReturnTypeMap.get(name);
      if (!existing || entry.confidence > existing.confidence) globalReturnTypeMap.set(name, entry);
    }
  }

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols.callAssignments?.length) continue;
    const importedNamesMap = buildImportedNamesMap(ctx, relPath, symbols, rootDir);

    for (const ca of symbols.callAssignments) {
      if (symbols.typeMap.has(ca.varName)) continue; // already resolved locally

      let returnEntry: TypeMapEntry | undefined;
      if (ca.receiverTypeName) {
        returnEntry = globalReturnTypeMap.get(`${ca.receiverTypeName}.${ca.calleeName}`);
      } else {
        const importedFrom = importedNamesMap.get(ca.calleeName);
        if (importedFrom) returnEntry = returnTypeIndex.get(importedFrom)?.get(ca.calleeName);
      }

      if (returnEntry) {
        const propagatedConf = returnEntry.confidence - PROPAGATION_HOP_PENALTY;
        if (propagatedConf > 0)
          setTypeMapEntry(symbols.typeMap, ca.varName, returnEntry.type, propagatedConf);
      }
    }
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
    const typeMapRaw: Array<{ name: string; typeName: string; confidence: number }> =
      symbols.typeMap instanceof Map
        ? [...symbols.typeMap.entries()].map(([name, entry]) => ({
            name,
            typeName: typeof entry === 'string' ? entry : entry.type,
            confidence: typeof entry === 'object' ? entry.confidence : 0.9,
          }))
        : Array.isArray(symbols.typeMap)
          ? (symbols.typeMap as Array<{ name: string; typeName: string; confidence: number }>)
          : [];
    // Deduplicate: keep highest-confidence entry per name (first-wins on tie),
    // matching JS setTypeMapEntry semantics.  The Map branch is already
    // deduped by setTypeMapEntry — this loop is only needed for the Array
    // branch (pre-rebuilt native addon) but runs unconditionally as
    // belt-and-suspenders since it's a cheap O(n) pass.
    const typeMapDedup = new Map<string, { name: string; typeName: string; confidence: number }>();
    for (const entry of typeMapRaw) {
      const existing = typeMapDedup.get(entry.name);
      if (!existing || entry.confidence > existing.confidence) {
        typeMapDedup.set(entry.name, entry);
      }
    }
    const typeMap = [...typeMapDedup.values()];
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
      fnRefBindings: symbols.fnRefBindings?.length ? symbols.fnRefBindings : undefined,
    });
  }

  const nativeEdges = native.buildCallEdges(nativeFiles, allNodes, [
    ...BUILTIN_RECEIVERS,
  ]) as NativeEdge[];
  for (const e of nativeEdges) {
    allEdgeRows.push([e.sourceId, e.targetId, e.kind, e.confidence, e.dynamic]);
  }
}

/**
 * Phase 8.3c pts post-pass for the native call-edge path.
 *
 * The native Rust engine builds call edges without knowledge of paramBindings,
 * so `fn()` calls inside higher-order functions are not resolved to their
 * concrete targets. This JS post-pass runs after the native edge pass and adds
 * only the parameter-flow pts edges that the native engine missed.
 *
 * To avoid duplicating edges already emitted by the native engine, the current
 * allEdgeRows snapshot is used to seed a seenByPair set before processing each
 * file.
 */
function buildParamFlowPtsPostPass(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
): void {
  // Only process files that actually have paramBindings (avoid useless work).
  const filesWithParams = [...ctx.fileSymbols].filter(
    ([, symbols]) => symbols.paramBindings && symbols.paramBindings.length > 0,
  );
  if (filesWithParams.length === 0) return;

  // Seed seenByPair from the existing rows so we don't duplicate native edges.
  // This is O(|allEdgeRows|) once per post-pass, which is acceptable.
  const seenByPair = new Set<string>();
  for (const [srcId, tgtId] of allEdgeRows) {
    seenByPair.add(`${srcId}|${tgtId}`);
  }

  const { barrelOnlyFiles, rootDir } = ctx;
  const lookup = makeContextLookup(ctx, getNodeIdStmt);

  for (const [relPath, symbols] of filesWithParams) {
    if (barrelOnlyFiles.has(relPath)) continue;
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;

    const importedNames = buildImportedNamesMap(ctx, relPath, symbols, rootDir);
    const typeMap: Map<string, TypeMapEntry | string> = symbols.typeMap || new Map();
    const ptsMap = buildPointsToMapForFile(symbols, importedNames);
    if (!ptsMap) continue;

    for (const call of symbols.calls) {
      if (call.receiver || call.dynamic) continue; // pts post-pass handles only param-flow (non-dynamic)

      const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
      const scopedKey = caller.callerName != null ? `${caller.callerName}::${call.name}` : null;
      if (!scopedKey || !ptsMap.has(scopedKey)) continue;

      // Only resolve calls that had no direct targets (same guard as buildFileCallEdges).
      const { targets } = resolveCallTargets(
        lookup,
        call,
        relPath,
        importedNames,
        typeMap as Map<string, unknown>,
      );
      if (targets.length > 0) continue;

      for (const alias of resolveViaPointsTo(scopedKey, ptsMap)) {
        const { targets: aliasTargets, importedFrom: aliasFrom } = resolveCallTargets(
          lookup,
          { name: alias },
          relPath,
          importedNames,
          typeMap as Map<string, unknown>,
        );
        for (const t of aliasTargets) {
          const edgeKey = `${caller.id}|${t.id}`;
          if (t.id !== caller.id && !seenByPair.has(edgeKey)) {
            const conf =
              computeConfidence(relPath, t.file, aliasFrom ?? null) - PROPAGATION_HOP_PENALTY;
            if (conf > 0) {
              seenByPair.add(edgeKey);
              allEdgeRows.push([caller.id, t.id, 'calls', conf, 0]);
            }
          }
        }
      }
    }
  }
}

function buildImportedNamesForNative(
  ctx: PipelineContext,
  relPath: string,
  symbols: ExtractorOutput,
  rootDir: string,
): Array<{ name: string; file: string }> {
  const importedNames: Array<{ name: string; file: string }> = [];
  // Process dynamic imports first (lower priority), then static imports
  // (higher priority). Rust HashMap::collect keeps the last entry per key,
  // so static imports win when both contribute the same name.
  const addImports = (imp: (typeof symbols.imports)[number]) => {
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    for (const name of imp.names) {
      const cleanName = name.replace(/^\*\s+as\s+/, '');
      let targetFile = resolvedPath;
      if (isBarrelFile(ctx, resolvedPath)) {
        const actual = resolveBarrelExportCached(ctx, resolvedPath, cleanName);
        if (actual) targetFile = actual;
      }
      importedNames.push({ name: cleanName, file: targetFile });
    }
  };
  for (const imp of symbols.imports) {
    if (imp.dynamicImport) addImports(imp);
  }
  for (const imp of symbols.imports) {
    if (!imp.dynamicImport) addImports(imp);
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
  const lookup = makeContextLookup(ctx, getNodeIdStmt);

  for (const [relPath, symbols] of fileSymbols) {
    if (barrelOnlyFiles.has(relPath)) continue;
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;

    const importedNames = buildImportedNamesMap(ctx, relPath, symbols, rootDir);
    const typeMap: Map<string, TypeMapEntry | string> = symbols.typeMap || new Map();
    const seenCallEdges = new Set<string>();
    const ptsMap = buildPointsToMapForFile(symbols, importedNames);

    buildFileCallEdges(
      relPath,
      symbols,
      fileNodeRow,
      importedNames,
      seenCallEdges,
      lookup,
      allEdgeRows,
      typeMap,
      ptsMap,
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
  // Process dynamic imports first (lower priority), then static imports
  // (higher priority). Static imports represent direct bindings while dynamic
  // imports often use aliased destructuring (`{ foo: bar } = await import(…)`).
  // When both contribute the same name, the static binding is authoritative.
  //
  // Phase 8.4: trace through barrel files so that symbol names map to their
  // actual definition file, not the re-exporting barrel. Mirrors the tracing
  // already done in buildImportedNamesForNative (the native path).
  const traceBarrel = (resolvedPath: string, cleanName: string): string => {
    if (!isBarrelFile(ctx, resolvedPath)) return resolvedPath;
    const actual = resolveBarrelExportCached(ctx, resolvedPath, cleanName);
    return actual ?? resolvedPath;
  };
  for (const imp of symbols.imports) {
    if (!imp.dynamicImport) continue;
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    for (const name of imp.names) {
      const cleanName = name.replace(/^\*\s+as\s+/, '');
      importedNames.set(cleanName, traceBarrel(resolvedPath, cleanName));
    }
  }
  for (const imp of symbols.imports) {
    if (imp.dynamicImport) continue;
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    for (const name of imp.names) {
      const cleanName = name.replace(/^\*\s+as\s+/, '');
      importedNames.set(cleanName, traceBarrel(resolvedPath, cleanName));
    }
  }
  return importedNames;
}

function makeContextLookup(ctx: PipelineContext, getNodeIdStmt: NodeIdStmt): CallNodeLookup {
  return {
    byNameAndFile: (name, file) => ctx.nodesByNameAndFile.get(`${name}|${file}`) ?? [],
    byName: (name) => ctx.nodesByName.get(name) ?? [],
    isBarrel: (file) => isBarrelFile(ctx, file),
    resolveBarrel: (barrelFile, symbolName) =>
      resolveBarrelExportCached(ctx, barrelFile, symbolName),
    nodeId: (name, kind, file, line) => getNodeIdStmt.get(name, kind, file, line),
  };
}

/**
 * Build a per-file points-to map for Phase 8.3 alias resolution.
 * Returns null fast when the file has no function-reference bindings.
 *
 * Only callable definitions (function/method) are seeded as concrete targets.
 * Class and interface names are intentionally excluded — aliasing a constructor
 * (`const Svc = MyService`) is an uncommon pattern that would require tracking
 * `new`-expression flows separately from the alias chain. That is left to Phase
 * 8.2 call-assignment propagation, which already handles constructor assignments.
 */
function buildPointsToMapForFile(
  symbols: ExtractorOutput,
  importedNames: Map<string, string>,
): PointsToMap | null {
  if (!symbols.fnRefBindings?.length && !symbols.paramBindings?.length) return null;
  const defNames = new Set(
    symbols.definitions
      .filter((d) => d.kind === 'function' || d.kind === 'method')
      .map((d) => d.name),
  );
  const definitionParams = buildDefinitionParamsMap(symbols.definitions);
  return buildPointsToMap(
    symbols.fnRefBindings ?? [],
    defNames,
    importedNames,
    symbols.paramBindings,
    definitionParams,
  );
}

function buildDefinitionParamsMap(
  definitions: readonly Definition[],
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const def of definitions) {
    if ((def.kind === 'function' || def.kind === 'method') && def.children) {
      const params = def.children.filter((c) => c.kind === 'parameter').map((c) => c.name);
      if (params.length > 0) {
        if (map.has(def.name)) {
          // Two definitions share the same name (e.g. overloads, same-named method and
          // function, or conditional redeclaration). Keep the first entry — using the
          // wrong parameter list would map argIndex to the wrong parameter name.
          debug(
            `buildDefinitionParamsMap: duplicate def name "${def.name}" (kind=${def.kind}, line=${def.line}) — skipping; first entry kept`,
          );
        } else {
          map.set(def.name, params);
        }
      }
    }
  }
  return map;
}

function buildFileCallEdges(
  relPath: string,
  symbols: ExtractorOutput,
  fileNodeRow: { id: number },
  importedNames: Map<string, string>,
  seenCallEdges: Set<string>,
  lookup: CallNodeLookup,
  allEdgeRows: EdgeRowTuple[],
  typeMap: Map<string, TypeMapEntry | string>,
  ptsMap?: PointsToMap | null,
): void {
  // Tracks edges that were inserted by the pts fallback (edgeKey → allEdgeRows index).
  // Kept separate from seenCallEdges so that a subsequent direct-call edge for the same
  // caller→target pair can upgrade the confidence in-place rather than being silently
  // dropped by the dedup guard. Once upgraded, the key moves to seenCallEdges and is
  // no longer tracked here.
  const ptsEdgeRows = new Map<string, number>();

  for (const call of symbols.calls) {
    if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;

    const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
    const isDynamic: number = call.dynamic ? 1 : 0;
    const { targets, importedFrom } = resolveCallTargets(
      lookup,
      call,
      relPath,
      importedNames,
      typeMap as Map<string, unknown>,
    );

    for (const t of targets) {
      const edgeKey = `${caller.id}|${t.id}`;
      if (t.id !== caller.id) {
        const confidence = computeConfidence(relPath, t.file, importedFrom ?? null);
        if (seenCallEdges.has(edgeKey)) continue;
        const ptsIdx = ptsEdgeRows.get(edgeKey);
        if (ptsIdx !== undefined) {
          // A pts-resolved edge already exists for this caller→target pair with a
          // penalised confidence. Upgrade it to the direct-call confidence in-place,
          // then promote to seenCallEdges so no further processing is needed.
          const ptsRow = allEdgeRows[ptsIdx];
          if (ptsRow) {
            ptsRow[3] = confidence;
            ptsRow[4] = isDynamic; // upgrade is_dynamic: direct call overrides the pts-alias dynamic flag
          }
          ptsEdgeRows.delete(edgeKey);
          seenCallEdges.add(edgeKey);
        } else {
          seenCallEdges.add(edgeKey);
          allEdgeRows.push([caller.id, t.id, 'calls', confidence, isDynamic]);
        }
      }
    }

    // Phase 8.3 / 8.3c: points-to fallback for unresolved calls.
    // Fires for two cases:
    //   (a) dynamic=true: alias calls emitted by extractCallbackReferenceCalls.
    //       Looks up `call.name` directly (alias entries are flat-keyed).
    //   (b) non-dynamic: parameter variable calls (fn() where fn is a param).
    //       Looks up the scoped key `callerName::call.name` to avoid spurious
    //       edges from same-named parameters across different functions.
    // Confidence is penalised by one hop to reflect the extra indirection.
    //
    // Note: pts edges are added to ptsEdgeRows (not seenCallEdges) so that a later
    // direct call to the same target in the same function body can upgrade confidence
    // rather than being silently dropped by the dedup guard.
    const scopedPtsKey = caller.callerName != null ? `${caller.callerName}::${call.name}` : null;
    if (
      targets.length === 0 &&
      !call.receiver &&
      ptsMap &&
      (call.dynamic || (scopedPtsKey != null && ptsMap.has(scopedPtsKey)))
    ) {
      const ptsLookupName = call.dynamic ? call.name : (scopedPtsKey ?? call.name);
      for (const alias of resolveViaPointsTo(ptsLookupName, ptsMap)) {
        // Resolve the concrete alias target. Only `name` is needed here — receiver
        // and line are not relevant for alias resolution (we are looking up the
        // aliased function by name, not dispatching a method call).
        const { targets: aliasTargets, importedFrom: aliasFrom } = resolveCallTargets(
          lookup,
          { name: alias },
          relPath,
          importedNames,
          typeMap as Map<string, unknown>,
        );
        for (const t of aliasTargets) {
          const edgeKey = `${caller.id}|${t.id}`;
          if (t.id !== caller.id && !seenCallEdges.has(edgeKey) && !ptsEdgeRows.has(edgeKey)) {
            const conf =
              computeConfidence(relPath, t.file, aliasFrom ?? null) - PROPAGATION_HOP_PENALTY;
            if (conf > 0) {
              ptsEdgeRows.set(edgeKey, allEdgeRows.length);
              allEdgeRows.push([caller.id, t.id, 'calls', conf, isDynamic]);
            }
          }
        }
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
        typeMap as Map<string, unknown>,
        seenCallEdges,
      );
      if (recv) {
        allEdgeRows.push([recv.callerId, recv.receiverId, 'receiver', recv.confidence, 0]);
      }
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

// ── Reverse-dep edge reconnection (#932, #933) ─────────────────────────

/**
 * Reconnect edges that were saved before changed-file purge.
 *
 * Each saved edge records: sourceId (still valid — reverse-dep nodes were not
 * purged) and target attributes (name, kind, file, line).  The target node was
 * deleted and re-inserted with a new ID by insertNodes.  We look up the new ID
 * by (name, kind, file) and re-create the edge.
 */
function reconnectReverseDepEdges(ctx: PipelineContext): void {
  const { db } = ctx;
  const findNodeStmt = db.prepare(
    'SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? ORDER BY ABS(line - ?) LIMIT 1',
  );
  const reconnectedRows: EdgeRowTuple[] = [];
  let dropped = 0;

  for (const saved of ctx.savedReverseDepEdges) {
    const newTarget = findNodeStmt.get(
      saved.tgtName,
      saved.tgtKind,
      saved.tgtFile,
      saved.tgtLine,
    ) as { id: number } | undefined;
    if (newTarget) {
      reconnectedRows.push([
        saved.sourceId,
        newTarget.id,
        saved.edgeKind,
        saved.confidence,
        saved.dynamic,
      ]);
    } else {
      // Target was removed or renamed in the changed file — edge is stale
      dropped++;
    }
  }

  if (reconnectedRows.length > 0) {
    if (ctx.nativeDb?.bulkInsertEdges) {
      const nativeEdges = reconnectedRows.map((r) => ({
        sourceId: r[0],
        targetId: r[1],
        kind: r[2],
        confidence: r[3],
        dynamic: r[4],
      }));
      const ok = ctx.nativeDb.bulkInsertEdges(nativeEdges);
      if (!ok) {
        batchInsertEdges(db, reconnectedRows);
      }
    } else {
      batchInsertEdges(db, reconnectedRows);
    }
  }

  debug(
    `Reconnected ${reconnectedRows.length} reverse-dep edges` +
      (dropped > 0 ? ` (${dropped} dropped — targets removed/renamed)` : ''),
  );
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * For small incremental builds (≤5 changed files on a large codebase), scope
 * the node loading query to only files that are relevant: changed files +
 * their import targets. Falls back to loading ALL nodes for full builds or
 * larger incremental changes.
 */
const NODE_KIND_FILTER_SQL = `kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant')`;

function loadNodes(ctx: PipelineContext): { rows: QueryNodeRow[]; scoped: boolean } {
  const { db, fileSymbols, isFullBuild, batchResolved } = ctx;
  const nodeKindFilter = NODE_KIND_FILTER_SQL;

  // Gate: only scope for small incremental on large codebases
  if (!isFullBuild && fileSymbols.size <= ctx.config.build.smallFilesThreshold) {
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
  // Match the upfront kind filter exactly. Using `kind != 'file'` here lets
  // parameters, properties, and other non-definition kinds leak into call
  // resolution, producing bogus call edges like `parser.ts → <a parameter
  // with the same name>` (#1174 follow-up). Calls only ever target the
  // definition kinds, so the fallback's filter must agree with `loadNodes`.
  const fallbackStmt = db.prepare(
    `SELECT id, name, kind, file, line FROM nodes WHERE name = ? AND ${NODE_KIND_FILTER_SQL}`,
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

  // Enrich typeMap for .ts/.tsx files using the TypeScript compiler API.
  // Runs before call-edge construction so the accurate types are available
  // for method-call resolution. Gated on config so users can opt out.
  if (ctx.config.build.typescriptResolver) {
    await enrichTypeMapWithTsc(ctx.rootDir, ctx.fileSymbols);
  }

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

    // Skip native import-edge path for small incremental builds: napi-rs
    // marshaling overhead (~13ms) exceeds Rust computation savings at this scale.
    const useNativeImportEdges =
      native?.buildImportEdges &&
      (ctx.isFullBuild || ctx.fileSymbols.size > ctx.config.build.smallFilesThreshold);
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

    // Skip native call-edge path for small incremental builds: napi-rs
    // marshaling overhead for allNodes exceeds Rust computation savings.
    const useNativeCallEdges =
      native?.buildCallEdges &&
      (ctx.isFullBuild || ctx.fileSymbols.size > ctx.config.build.smallFilesThreshold);
    if (useNativeCallEdges) {
      buildCallEdgesNative(ctx, getNodeIdStmt, allEdgeRows, allNodesBefore, native!);
      // Phase 8.3c post-pass: augment native call edges with parameter-flow pts
      // edges. The native Rust engine has no knowledge of paramBindings, so any
      // `fn()` call inside a higher-order function would be missed. This JS pass
      // runs on top of the native edges and adds only the pts-resolved edges that
      // the native engine could not produce.
      buildParamFlowPtsPostPass(ctx, getNodeIdStmt, allEdgeRows);
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
  // Phase 8.2: Augment typeMaps with cross-file return-type propagation before
  // the transaction opens. This is pure in-memory mutation (no DB I/O) and must
  // run outside the transaction to avoid leaving ctx.fileSymbols in a partial
  // state if the transaction rolls back unexpectedly.
  propagateReturnTypesAcrossFiles(ctx.fileSymbols, ctx, ctx.rootDir);
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

  // Phase 3: Reconnect saved reverse-dep edges (#932, #933).
  // When the WASM/JS path purged changed files, edges FROM reverse-dep files TO
  // those files were deleted (target-side).  The reverse-dep files were NOT
  // reparsed — instead we saved the edge topology before purge and now reconnect
  // each edge to the new node IDs created by insertNodes.
  if (ctx.savedReverseDepEdges.length > 0) {
    reconnectReverseDepEdges(ctx);
  }

  ctx.timing.edgesMs = performance.now() - t0;
}
