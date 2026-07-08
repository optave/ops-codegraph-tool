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
import { getOrCreatePerDbChunkStmt } from '../../../../shared/chunked-stmt-cache.js';
import { TS_NATIVE_CONFIDENCE_FLOOR } from '../../../../shared/constants.js';
import type {
  ArrayCallbackBinding,
  ArrayElemBinding,
  BetterSqlite3Database,
  Call,
  ClassRelation,
  Definition,
  DynamicKind,
  ExtractorOutput,
  FnRefBinding,
  ForOfBinding,
  Import,
  NativeAddon,
  NodeRow,
  ObjectPropBinding,
  ObjectRestParamBinding,
  ParamBinding,
  SpreadArgBinding,
  SqliteStatement,
  ThisCallBinding,
  TypeMapEntry,
} from '../../../../types.js';
import { computeConfidence } from '../../resolve.js';
import type { PointsToMap } from '../../resolver/points-to.js';
import { buildPointsToMap, resolveViaPointsTo } from '../../resolver/points-to.js';
import { unwrapTypeEntry } from '../../resolver/strategy.js';
import { enrichTypeMapWithTsc } from '../../resolver/ts-resolver.js';
import {
  type CallNodeLookup,
  findCaller,
  isModuleScopedLanguage,
  resolveCallTargets,
  resolveDefinePropertyAccessorTarget,
  resolveReceiverEdge,
  resolveSameClassQualifiedMethod,
} from '../call-resolver.js';
import type { ChaContext } from '../cha.js';
import { buildChaContext, resolveChaTargets, resolveThisDispatch } from '../cha.js';
import type { PipelineContext } from '../context.js';
import {
  BUILTIN_RECEIVERS,
  batchInsertEdges,
  CHA_DISPATCH_PENALTY,
  CHA_TYPED_DISPATCH_CONFIDENCE,
  runChaPostPass,
} from '../helpers.js';
import { importNamePairs } from '../import-utils.js';
import { getResolved, isBarrelFile, resolveBarrelExportCached } from './resolve-imports.js';

// ── Local types ──────────────────────────────────────────────────────────

type EdgeRowTuple = [number, number, string, number, number, string | null, string | null];
//                   src    tgt    kind   conf   dyn   technique             dynamic_kind

/**
 * Tracks a dyn=0 direct-call edge row so a later dynamicKind-tagged call to the
 * same (caller, target) pair can decide whether to upgrade it in-place — see
 * {@link emitDirectCallEdgesForCall}. `line` is the source line of the call that
 * produced the row, used to detect out-of-source-order collection artifacts
 * (bare decorators processed after call-expression matches in the query path).
 */
interface DynZeroEdgeEntry {
  idx: number;
  line: number;
}

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
  definitions: Array<{
    name: string;
    kind: string;
    line: number;
    endLine: number | null;
    params?: string[];
  }>;
  calls: Call[];
  importedNames: Array<{ name: string; file: string; imported?: string }>;
  classes: ClassRelation[];
  typeMap: Array<{ name: string; typeName: string; confidence: number }>;
  /** Phase 8.3: function-reference bindings for pts analysis. */
  fnRefBindings?: Array<{ lhs: string; rhs: string; rhsReceiver?: string }>;
  paramBindings?: ParamBinding[];
  thisCallBindings?: ThisCallBinding[];
  arrayElemBindings?: ArrayElemBinding[];
  spreadArgBindings?: SpreadArgBinding[];
  forOfBindings?: ForOfBinding[];
  arrayCallbackBindings?: ArrayCallbackBinding[];
  objectRestParamBindings?: ObjectRestParamBinding[];
  objectPropBindings?: ObjectPropBinding[];
}

/** Shape returned by native buildCallEdges. */
interface NativeEdge {
  sourceId: number;
  targetId: number;
  kind: string;
  confidence: number;
  dynamic: number;
  dynamic_kind?: string | null;
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
 * Emit one symbol-level edge per named specifier in `imp`, pointing at the
 * specific target symbol (resolved through barrel chains when needed).
 *
 * Shared by two statement shapes that name specific symbols without a plain
 * file-level `imports`/`reexports` edge fully capturing the relationship:
 *   - `import type { X } from 'Y'` → kind `imports-type`, so the target gets
 *     fan-in credit and isn't classified as dead code (#1724).
 *   - `export { X } from 'Y'` / `export { X as Z } from 'Y'` → kind
 *     `reexports`, so `codegraph exports` can report exactly which symbols
 *     are re-exported instead of conflating the file-level barrel edge with
 *     "every export of Y" (#1742).
 *
 * `imp.names` always carries the *original* declaration name for export
 * specifiers, even when renamed externally (see `extractImportNames`), so
 * the emitted edge — and the resulting `reexportedSymbols` entry — reports
 * the symbol under its own declared name, not the barrel's external alias.
 *
 * Wildcard re-exports (`export * from 'Y'`) carry no specific names
 * (`imp.names` is empty), so the loop below is a no-op for them — a file
 * only gets a precise symbol-level edge when a name is actually spelled
 * out; the query layer falls back to the target's full export list for
 * anything reached only by the file-level edge (genuine wildcard semantics).
 */
function emitNamedSymbolEdges(
  ctx: PipelineContext,
  imp: Import,
  resolvedPath: string,
  fileNodeId: number,
  allEdgeRows: EdgeRowTuple[],
  edgeKind: 'imports-type' | 'reexports',
): void {
  if (!ctx.nodesByNameAndFile) return;
  for (const { original } of importNamePairs(imp)) {
    let targetFile = resolvedPath;
    if (isBarrelFile(ctx, resolvedPath)) {
      const actual = resolveBarrelExportCached(ctx, resolvedPath, original);
      if (actual) targetFile = actual;
    }
    const candidates = ctx.nodesByNameAndFile.get(`${original}|${targetFile}`);
    if (candidates && candidates.length > 0) {
      allEdgeRows.push([fileNodeId, candidates[0]!.id, edgeKind, 1.0, 0, null, null]);
    }
  }
}

/**
 * Process a single import statement and emit all resulting edges (file→file,
 * named-symbol-level, and barrel re-export targets).
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
  allEdgeRows.push([fileNodeId, targetRow.id, edgeKind, 1.0, 0, null, null]);

  if (imp.typeOnly) {
    emitNamedSymbolEdges(ctx, imp, resolvedPath, fileNodeId, allEdgeRows, 'imports-type');
  }
  if (imp.reexport && !imp.wildcardReexport) {
    emitNamedSymbolEdges(ctx, imp, resolvedPath, fileNodeId, allEdgeRows, 'reexports');
  } else if (imp.reexport && imp.wildcardReexport) {
    // A genuine wildcard needs to be distinguishable from a named reexport
    // even when a *different* statement in the same file names specific
    // symbols from this exact target — otherwise the query layer can't tell
    // "only these symbols are re-exported" apart from "everything is
    // re-exported, and these happen to also be individually named" (#1849
    // review). See `collectReexportedSymbols` in domain/analysis/exports.ts.
    allEdgeRows.push([fileNodeId, targetRow.id, 'reexports-wildcard', 1.0, 0, null, null]);
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
  for (const { original } of importNamePairs(imp)) {
    const actualSource = resolveBarrelExportCached(ctx, resolvedPath, original);
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
        edgeRows.push([fileNodeId, actualRow.id, kind, 0.9, 0, null, null]);
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
    allEdgeRows.push([e.sourceId, e.targetId, e.kind, e.confidence, e.dynamic, null, null]);
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
    // Phase 8.4 side-effect: buildImportedNamesMap now traces through barrel
    // files (traceBarrel), so `importedFrom` resolves to the leaf definition
    // file rather than the barrel. This means returnTypeIndex.get(importedFrom)
    // now finds entries it previously missed, improving cross-file return-type
    // propagation through re-export chains (Phase 8.2 improvement).
    const { importedNames: importedNamesMap, importedOriginalNames } = buildImportedNamesMap(
      ctx,
      relPath,
      symbols,
      rootDir,
    );

    for (const ca of symbols.callAssignments) {
      if (symbols.typeMap.has(ca.varName)) continue; // already resolved locally

      let returnEntry: TypeMapEntry | undefined;
      if (ca.receiverTypeName) {
        returnEntry = globalReturnTypeMap.get(`${ca.receiverTypeName}.${ca.calleeName}`);
      } else {
        const importedFrom = importedNamesMap.get(ca.calleeName);
        // The return-type index for the imported file is keyed by the
        // function's own declared name — use the original (pre-rename) name
        // when the call-assignment's callee is a renamed import binding (#1730).
        const calleeOriginalName = importedOriginalNames.get(ca.calleeName) ?? ca.calleeName;
        if (importedFrom) returnEntry = returnTypeIndex.get(importedFrom)?.get(calleeOriginalName);
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

/**
 * Build the deduplicated native typeMap array for a single file's symbols.
 * Deduplicate: keep highest-confidence entry per name (first-wins on tie),
 * matching JS setTypeMapEntry semantics.  The Map branch is already
 * deduped by setTypeMapEntry — this loop is only needed for the Array
 * branch (pre-rebuilt native addon) but runs unconditionally as
 * belt-and-suspenders since it's a cheap O(n) pass.
 */
function buildNativeTypeMapEntries(
  symbols: ExtractorOutput,
): Array<{ name: string; typeName: string; confidence: number }> {
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
  const typeMapDedup = new Map<string, { name: string; typeName: string; confidence: number }>();
  for (const entry of typeMapRaw) {
    const existing = typeMapDedup.get(entry.name);
    if (!existing || entry.confidence > existing.confidence) {
      typeMapDedup.set(entry.name, entry);
    }
  }
  return [...typeMapDedup.values()];
}

/** Build the native FFI file entry for a single file, including pts-analysis bindings. */
function buildNativeFileEntry(
  ctx: PipelineContext,
  relPath: string,
  fileNodeId: number,
  symbols: ExtractorOutput,
  rootDir: string,
): NativeFileEntry {
  const importedNames = buildImportedNamesForNative(ctx, relPath, symbols, rootDir);
  const typeMap = buildNativeTypeMapEntries(symbols);
  return {
    file: relPath,
    fileNodeId,
    definitions: symbols.definitions.map((d) => {
      const params = d.children?.filter((c) => c.kind === 'parameter').map((c) => c.name);
      return {
        name: d.name,
        kind: d.kind,
        line: d.line,
        endLine: d.endLine ?? null,
        params: params?.length ? params : undefined,
      };
    }),
    calls: symbols.calls,
    importedNames,
    classes: symbols.classes,
    typeMap,
    fnRefBindings: symbols.fnRefBindings?.length ? symbols.fnRefBindings : undefined,
    paramBindings: symbols.paramBindings?.length ? symbols.paramBindings : undefined,
    thisCallBindings: symbols.thisCallBindings?.length ? symbols.thisCallBindings : undefined,
    arrayElemBindings: symbols.arrayElemBindings?.length ? symbols.arrayElemBindings : undefined,
    spreadArgBindings: symbols.spreadArgBindings?.length ? symbols.spreadArgBindings : undefined,
    forOfBindings: symbols.forOfBindings?.length ? symbols.forOfBindings : undefined,
    arrayCallbackBindings: symbols.arrayCallbackBindings?.length
      ? symbols.arrayCallbackBindings
      : undefined,
    objectRestParamBindings: symbols.objectRestParamBindings?.length
      ? symbols.objectRestParamBindings
      : undefined,
    objectPropBindings: symbols.objectPropBindings?.length ? symbols.objectPropBindings : undefined,
  };
}

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

    nativeFiles.push(buildNativeFileEntry(ctx, relPath, fileNodeRow.id, symbols, rootDir));
  }

  const nativeEdges = native.buildCallEdges(
    nativeFiles,
    allNodes,
    [...BUILTIN_RECEIVERS],
    ctx.config.analysis.pointsToMaxIterations,
  ) as NativeEdge[];
  for (const e of nativeEdges) {
    allEdgeRows.push([
      e.sourceId,
      e.targetId,
      e.kind,
      e.confidence,
      e.dynamic,
      e.kind === 'calls' ? 'ts-native' : null,
      e.dynamic_kind ?? null,
    ]);
  }
}

/**
 * Object.defineProperty accessor post-pass for the native call-edge path.
 *
 * When a function is registered as a getter/setter via
 * `Object.defineProperty(obj, "bar", { get: getter })`, calls to `this.X()`
 * inside `getter` need to resolve against `obj` (because `this === obj` when
 * the accessor is invoked). The native Rust engine has no knowledge of
 * `definePropertyReceivers`, so this JS post-pass adds the missing edges.
 */
function buildDefinePropertyPostPass(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  sharedLookup?: CallNodeLookup,
): void {
  const filesWithReceivers = [...ctx.fileSymbols].filter(
    ([, symbols]) => symbols.definePropertyReceivers && symbols.definePropertyReceivers.size > 0,
  );
  if (filesWithReceivers.length === 0) return;

  const seenByPair = new Set<string>();
  for (const [srcId, tgtId] of allEdgeRows) {
    seenByPair.add(`${srcId}|${tgtId}`);
  }

  const { barrelOnlyFiles, rootDir } = ctx;
  const lookup = sharedLookup ?? makeContextLookup(ctx, getNodeIdStmt);

  for (const [relPath, symbols] of filesWithReceivers) {
    if (barrelOnlyFiles.has(relPath)) continue;
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;

    const { importedNames, importedOriginalNames } = buildImportedNamesMap(
      ctx,
      relPath,
      symbols,
      rootDir,
    );
    const typeMap: Map<string, TypeMapEntry | string> = symbols.typeMap || new Map();
    const definePropertyReceivers = symbols.definePropertyReceivers!;

    for (const call of symbols.calls) {
      if (call.receiver !== 'this') continue;

      const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
      if (!caller.callerName) continue;

      const receiverVarName = definePropertyReceivers.get(caller.callerName);
      if (!receiverVarName) continue;

      // Only add edges the native engine missed (no direct target already).
      const { targets: directTargets } = resolveCallTargets(
        lookup,
        call,
        relPath,
        importedNames,
        typeMap as Map<string, unknown>,
        caller.callerName,
        importedOriginalNames,
      );
      if (directTargets.length > 0) continue;

      // Resolve via receiver type, restricted to function/method kinds
      // (shared with the WASM-path fallback and incremental.ts — issue #1766).
      const targets = resolveDefinePropertyAccessorTarget(
        call.name,
        caller.callerName,
        relPath,
        typeMap as Map<string, unknown>,
        lookup,
        definePropertyReceivers,
      );

      for (const t of targets) {
        const edgeKey = `${caller.id}|${t.id}`;
        if (t.id !== caller.id && !seenByPair.has(edgeKey)) {
          const conf = computeConfidence(relPath, t.file, null);
          if (conf > 0) {
            seenByPair.add(edgeKey);
            allEdgeRows.push([caller.id, t.id, 'calls', conf, 0, 'ts-native', null]);
          }
        }
      }
    }
  }
}

/**
 * Phase 8.5: CHA + RTA post-pass for the native call-edge path.
 *
 * The native Rust engine has no knowledge of the CHA context, so `this.method()`
 * calls and interface method dispatches are not expanded to their concrete
 * implementations.  This JS post-pass runs after the native edges and adds only
 * the CHA-resolved edges that the native engine missed.
 *
 * Seeds seenByPair from the current allEdgeRows snapshot to avoid duplicating
 * edges the native engine already produced.
 */
function buildChaPostPass(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  chaCtx: ChaContext,
): void {
  // Fast-exit when the CHA context is empty (no class hierarchy in the project)
  if (chaCtx.implementors.size === 0 && chaCtx.parents.size === 0) return;

  // Seed only from 'calls' edges — import/extends/implements edges share (src,tgt) pairs
  // with real call edges at the file-node level and would cause false dedup if included.
  const seenByPair = new Set<string>();
  for (const row of allEdgeRows) {
    if (row[2] === 'calls') seenByPair.add(`${row[0]}|${row[1]}`);
  }

  const { fileSymbols, barrelOnlyFiles } = ctx;
  const lookup = makeContextLookup(ctx, getNodeIdStmt);

  for (const [relPath, symbols] of fileSymbols) {
    if (barrelOnlyFiles.has(relPath)) continue;
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;

    const typeMap: Map<string, TypeMapEntry | string> = symbols.typeMap || new Map();

    for (const call of symbols.calls) {
      if (!call.receiver) continue;
      if (BUILTIN_RECEIVERS.has(call.receiver)) continue;

      const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
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

      for (const t of chaTargets) {
        const edgeKey = `${caller.id}|${t.id}`;
        if (t.id !== caller.id && !seenByPair.has(edgeKey)) {
          // Typed-receiver (interface/CHA) dispatch: use CHA_TYPED_DISPATCH_CONFIDENCE
          // — file proximity is not meaningful for virtual dispatch confidence.
          // this/super dispatch keeps computeConfidence-based proximity scoring to
          // match runPostNativeThisDispatch (native-orchestrator.ts).
          const conf = isTypedReceiverDispatch
            ? CHA_TYPED_DISPATCH_CONFIDENCE
            : computeConfidence(relPath, t.file, null) - CHA_DISPATCH_PENALTY;
          if (conf > 0) {
            seenByPair.add(edgeKey);
            // Tag super-dispatch edges distinctly so runChaPostPass can exclude them
            // from further CHA expansion (super calls are not virtual dispatch).
            const technique = call.receiver === 'super' ? 'super-dispatch' : 'cha';
            allEdgeRows.push([caller.id, t.id, 'calls', conf, 0, technique, null]);
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
): Array<{ name: string; file: string; imported?: string }> {
  const importedNames: Array<{ name: string; file: string; imported?: string }> = [];
  // Process dynamic imports first (lower priority), then static imports
  // (higher priority). Rust HashMap::collect keeps the last entry per key,
  // so static imports win when both contribute the same name.
  const addImports = (imp: (typeof symbols.imports)[number]) => {
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    for (const { local, original } of importNamePairs(imp)) {
      let targetFile = resolvedPath;
      if (isBarrelFile(ctx, resolvedPath)) {
        const actual = resolveBarrelExportCached(ctx, resolvedPath, original);
        if (actual) targetFile = actual;
      }
      // `imported` carries the original (pre-rename) exported name so the
      // native resolver can look it up in `targetFile` instead of the local
      // alias, which only exists in this file (#1730). Omitted when unrenamed.
      const entry: { name: string; file: string; imported?: string } = {
        name: local,
        file: targetFile,
      };
      if (original !== local) entry.imported = original;
      importedNames.push(entry);
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
  chaCtx?: ChaContext,
): void {
  const { fileSymbols, barrelOnlyFiles, rootDir } = ctx;
  const lookup = makeContextLookup(ctx, getNodeIdStmt);

  for (const [relPath, symbols] of fileSymbols) {
    if (barrelOnlyFiles.has(relPath)) continue;
    const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
    if (!fileNodeRow) continue;

    const { importedNames, importedOriginalNames } = buildImportedNamesMap(
      ctx,
      relPath,
      symbols,
      rootDir,
    );
    const typeMap: Map<string, TypeMapEntry | string> = new Map(
      symbols.typeMap instanceof Map ? symbols.typeMap : [],
    );

    // Phase 8.3f: seed typeMap[callee::restName] = { type: argName } for each
    // object-destructuring rest parameter binding × call-site argument binding.
    // Keys are scoped so two functions with the same rest-param name in the same
    // file don't collide (#1358). When only one callee uses a given rest name,
    // also seed the unscoped key as a null-callerName fallback.
    if (symbols.objectRestParamBindings?.length && symbols.paramBindings?.length) {
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

    const seenCallEdges = new Set<string>();
    const ptsMap = buildPointsToMapForFile(
      symbols,
      importedNames,
      ctx.config.analysis.pointsToMaxIterations,
    );
    // Build the import-artifact name set: importedNames plus CJS require bindings.
    // Used only by resolveReceiverEdge to distinguish local definitions from CJS
    // import shadows — does NOT affect call-target resolution or DB edges (#1661).
    const importArtifactNames = buildImportArtifactNames(
      importedNames,
      symbols,
      ctx,
      relPath,
      rootDir,
    );

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
      chaCtx,
      importArtifactNames,
      importedOriginalNames,
    );
    buildClassHierarchyEdges(ctx, relPath, symbols, allEdgeRows);
  }
}

/**
 * Maps each locally-bound import name in `relPath` to the file it comes from
 * (`importedNames`), plus, for renamed specifiers (`import { X as Y }`), the
 * *original* exported name (`importedOriginalNames`, keyed by local name Y).
 *
 * Barrel tracing and downstream target-file symbol lookups must search using
 * the original name — the renamed local alias only exists in the importing
 * file, not in the file being imported from (#1730).
 */
function buildImportedNamesMap(
  ctx: PipelineContext,
  relPath: string,
  symbols: ExtractorOutput,
  rootDir: string,
): { importedNames: Map<string, string>; importedOriginalNames: Map<string, string> } {
  const importedNames = new Map<string, string>();
  const importedOriginalNames = new Map<string, string>();
  // Phase 8.4: trace through barrel files so that symbol names map to their
  // actual definition file, not the re-exporting barrel. Mirrors the tracing
  // already done in buildImportedNamesForNative (the native path).
  const traceBarrel = (resolvedPath: string, originalName: string): string => {
    if (!isBarrelFile(ctx, resolvedPath)) return resolvedPath;
    const actual = resolveBarrelExportCached(ctx, resolvedPath, originalName);
    return actual ?? resolvedPath;
  };
  const addImportNames = (imp: (typeof symbols.imports)[number], resolvedPath: string) => {
    for (const { local, original } of importNamePairs(imp)) {
      importedNames.set(local, traceBarrel(resolvedPath, original));
      if (original !== local) importedOriginalNames.set(local, original);
    }
  };
  // Process dynamic imports first (lower priority), then static imports
  // (higher priority). Static imports represent direct bindings while dynamic
  // imports often use aliased destructuring (`{ foo: bar } = await import(…)`).
  // When both contribute the same name, the static binding is authoritative.
  for (const imp of symbols.imports) {
    if (!imp.dynamicImport) continue;
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    addImportNames(imp, resolvedPath);
  }
  for (const imp of symbols.imports) {
    if (imp.dynamicImport) continue;
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    addImportNames(imp, resolvedPath);
  }
  return { importedNames, importedOriginalNames };
}

/**
 * Build a map of all names that are import artifacts in this file — includes
 * both ES module imports (already in importedNames) and CJS require destructuring
 * bindings (`const { X } = require('./path')`). Used exclusively by resolveReceiverEdge
 * to classify same-file function-kind nodes as import artifacts vs. local definitions.
 * Does NOT affect call resolution or DB edge creation (#1661).
 */
function buildImportArtifactNames(
  importedNames: Map<string, string>,
  symbols: ExtractorOutput,
  ctx: PipelineContext,
  relPath: string,
  rootDir: string,
): ReadonlyMap<string, string> {
  if (!symbols.cjsRequireBindings?.length) return importedNames;
  const combined = new Map(importedNames);
  const traceBarrel = (resolvedPath: string, cleanName: string): string => {
    if (!isBarrelFile(ctx, resolvedPath)) return resolvedPath;
    const actual = resolveBarrelExportCached(ctx, resolvedPath, cleanName);
    return actual ?? resolvedPath;
  };
  for (const binding of symbols.cjsRequireBindings) {
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), binding.source);
    for (const name of binding.names) {
      if (!combined.has(name)) {
        combined.set(name, traceBarrel(resolvedPath, name));
      }
    }
  }
  return combined;
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
 *
 * @param maxIterations - fixed-point solver iteration cap, forwarded to
 *   `buildPointsToMap` (resolved from `ctx.config.analysis.pointsToMaxIterations`
 *   by the caller, which already holds the pipeline's resolved config).
 */
function buildPointsToMapForFile(
  symbols: ExtractorOutput,
  importedNames: Map<string, string>,
  maxIterations: number,
): PointsToMap | null {
  const hasThisCallBindings = !!symbols.thisCallBindings?.length;
  if (
    !symbols.fnRefBindings?.length &&
    !symbols.paramBindings?.length &&
    !symbols.arrayElemBindings?.length &&
    !symbols.spreadArgBindings?.length &&
    !symbols.forOfBindings?.length &&
    !symbols.arrayCallbackBindings?.length &&
    !symbols.objectRestParamBindings?.length &&
    !symbols.objectPropBindings?.length &&
    !hasThisCallBindings
  )
    return null;
  const defNames = new Set(
    symbols.definitions
      .filter((d) => d.kind === 'function' || d.kind === 'method')
      .map((d) => d.name),
  );
  const definitionParams = buildDefinitionParamsMap(symbols.definitions);

  // Convert thisCallBindings into scoped fnRefBindings: `fn::this → namedCtx`.
  // The scoped key `fn::this` is looked up when `this()` calls are resolved inside
  // function `fn` — caller.callerName='fn', call.name='this' → scopedPtsKey='fn::this'.
  let allFnRefBindings: readonly FnRefBinding[] = symbols.fnRefBindings ?? [];
  if (hasThisCallBindings) {
    const extra: FnRefBinding[] = (symbols.thisCallBindings ?? []).map((b) => ({
      lhs: `${b.callee}::this`,
      rhs: b.thisArg,
    }));
    allFnRefBindings = [...allFnRefBindings, ...extra];
  }

  return buildPointsToMap(
    allFnRefBindings,
    defNames,
    importedNames,
    symbols.paramBindings,
    definitionParams,
    symbols.arrayElemBindings,
    symbols.spreadArgBindings,
    symbols.forOfBindings,
    symbols.arrayCallbackBindings,
    symbols.objectRestParamBindings,
    symbols.objectPropBindings,
    maxIterations,
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

// ── Per-call resolution helpers ─────────────────────────────────────────

/**
 * RES-4: Kotlin member callable reference — `Greeter::greet` emits
 * { name: 'greet', receiver: 'Greeter', dynamicKind: 'reflection' }.
 * The receiver is the class qualifier (not a typeMap variable), so
 * resolveCallTargets would find a same-named top-level function via
 * byNameAndFile('greet', relPath) before the qualified form is tried.
 * Prefer `Greeter.greet` in the same file first; fall through to the
 * normal path only when no qualified match exists.
 */
function resolveKotlinReflectionPreQualified(
  call: Call,
  relPath: string,
  lookup: CallNodeLookup,
): ReadonlyArray<{ id: number; file: string; kind?: string }> {
  if (
    call.dynamicKind === 'reflection' &&
    call.receiver &&
    !call.keyExpr &&
    !isModuleScopedLanguage(relPath)
  ) {
    return lookup
      .byNameAndFile(`${call.receiver}.${call.name}`, relPath)
      .filter((n) => n.kind === 'method' || n.kind === 'function');
  }
  return [];
}

/**
 * Same-class `this.method()` fallback: when the call receiver is `this` and
 * resolveCallTargets found nothing, derive the enclosing class name from the
 * caller (e.g. `Logger.info` → class prefix `Logger`) and retry with the
 * qualified method name `Logger._write`. This mirrors what the native Rust
 * engine does implicitly via its class-scoped symbol table.
 * NOTE: restricted to `this` only — `super.method()` targets a parent class,
 * not the enclosing class, so qualifying with the child class name would
 * produce a false edge when the child also defines a same-named method.
 */
function resolveSameClassThisFallback(
  call: Call,
  callerName: string | null,
  relPath: string,
  lookup: CallNodeLookup,
): Array<{ id: number; file: string; kind?: string }> {
  if (call.receiver !== 'this' || callerName == null) return [];
  return resolveSameClassQualifiedMethod(call.name, callerName, relPath, lookup);
}

/**
 * Same-class bare-call fallback: when a no-receiver call can't be resolved
 * globally, try the caller's own class as a qualifier. Handles C# static
 * sibling calls: `IsValidEmail()` inside `Validators.ValidateUser` resolves
 * to `Validators.IsValidEmail`. Skipped for JS/TS where bare calls are
 * module-scoped, not class-scoped.
 */
function resolveSameClassBareCallFallback(
  call: Call,
  callerName: string | null,
  relPath: string,
  lookup: CallNodeLookup,
): Array<{ id: number; file: string; kind?: string }> {
  if (call.receiver || callerName == null || isModuleScopedLanguage(relPath)) return [];
  return resolveSameClassQualifiedMethod(call.name, callerName, relPath, lookup);
}

/**
 * RES-3: reflection with literal method name — JVM getMethod("name") / invokeMethod("name").
 * Java/Scala/Groovy methods are stored as class-qualified names (e.g. Reflection.greet),
 * so lookup.byNameAndFile('greet', relPath) finds nothing. When dynamicKind='reflection'
 * and keyExpr is set (a string-literal method name was captured), try the qualified form:
 *   1. typeMap[receiver] → resolvedType → lookup `resolvedType.keyExpr` (type-annotated local)
 *   2. callerName class prefix → `CallerClass.keyExpr` (same-class sibling, e.g. Groovy obj)
 * Scoped to non-JS/TS files to avoid interfering with the JS reflection path.
 */
function resolveReflectionKeyExprFallback(
  call: Call,
  callerName: string | null,
  relPath: string,
  typeMap: Map<string, TypeMapEntry | string>,
  lookup: CallNodeLookup,
): Array<{ id: number; file: string; kind?: string }> {
  if (
    call.dynamicKind !== 'reflection' ||
    !call.keyExpr ||
    !call.receiver ||
    isModuleScopedLanguage(relPath)
  ) {
    return [];
  }
  const resolvedType = unwrapTypeEntry(typeMap.get(call.receiver));
  if (resolvedType) {
    const qualified = lookup
      .byNameAndFile(`${resolvedType}.${call.keyExpr}`, relPath)
      .filter((n) => n.kind === 'method' || n.kind === 'function');
    if (qualified.length > 0) return qualified;
  }
  if (callerName != null) {
    const lastDot = callerName.lastIndexOf('.');
    if (lastDot > 0) {
      const prevDot = callerName.lastIndexOf('.', lastDot - 1);
      const callerClass = callerName.slice(prevDot + 1, lastDot);
      const qualified = lookup
        .byNameAndFile(`${callerClass}.${call.keyExpr}`, relPath)
        .filter((n) => n.kind === 'method' || n.kind === 'function');
      if (qualified.length > 0) return qualified;
    }
  }
  return [];
}

/**
 * Object.defineProperty accessor fallback: when a function is registered as
 * a getter/setter via `Object.defineProperty(obj, "bar", { get: getter })`,
 * calls to `this.X()` inside `getter` resolve against `obj` (this === obj
 * when the accessor is invoked). If the same-class fallback above found
 * nothing, try treating `obj` as the receiver and look up `obj.X` in the
 * typeMap, or fall back to a same-file lookup of any definition named X
 * that belongs to the object literal or its type.
 *
 * Checks applicability (this-receiver + known caller + a receiver map to
 * consult) then delegates the actual resolution to the shared
 * `resolveDefinePropertyAccessorTarget` (call-resolver.ts), which is also
 * used by the native-engine post-pass below and by incremental.ts.
 */
function resolveDefinePropertyAccessorFallback(
  call: Call,
  callerName: string | null,
  relPath: string,
  typeMap: Map<string, TypeMapEntry | string>,
  lookup: CallNodeLookup,
  definePropertyReceivers: Map<string, string> | undefined,
): Array<{ id: number; file: string; kind?: string }> {
  if (call.receiver !== 'this' || callerName == null || !definePropertyReceivers) return [];
  return resolveDefinePropertyAccessorTarget(
    call.name,
    callerName,
    relPath,
    typeMap as Map<string, unknown>,
    lookup,
    definePropertyReceivers,
  );
}

/**
 * Resolve targets for a single call site with all JS-path fallbacks applied.
 *
 * Runs in order:
 *   1. Primary resolution via `resolveCallTargets` (importedNames + typeMap).
 *   2. Same-class `this.method()` fallback (non-super receivers only).
 *   3. Same-class bare-call fallback for non-JS/TS class-scoped languages.
 *   4. Object.defineProperty accessor fallback (this-calls inside getter/setter).
 *
 * Returns the resolved targets array and the importedFrom hint for confidence scoring.
 */
function resolveFallbackTargets(
  call: Call,
  caller: { id: number; callerName: string | null },
  relPath: string,
  importedNames: Map<string, string>,
  lookup: CallNodeLookup,
  typeMap: Map<string, TypeMapEntry | string>,
  definePropertyReceivers: Map<string, string> | undefined,
  importedOriginalNames?: ReadonlyMap<string, string>,
): {
  targets: ReadonlyArray<{ id: number; file: string; kind?: string }>;
  importedFrom: string | null | undefined;
} {
  const preQualifiedTargets = resolveKotlinReflectionPreQualified(call, relPath, lookup);

  let { targets, importedFrom } =
    preQualifiedTargets.length > 0
      ? {
          targets: preQualifiedTargets as Array<{ id: number; file: string; kind?: string }>,
          importedFrom: undefined as string | undefined,
        }
      : resolveCallTargets(
          lookup,
          call,
          relPath,
          importedNames,
          typeMap as Map<string, unknown>,
          caller.callerName,
          importedOriginalNames,
        );

  // Fallback strategies, applied in order until one yields a match. Each
  // helper folds its own applicability guard internally (see helper doc
  // comments above) — the checks here are unchanged from before, just
  // relocated to keep this dispatcher a thin, low-complexity orchestrator.
  if (targets.length === 0) {
    const qualified = resolveSameClassThisFallback(call, caller.callerName, relPath, lookup);
    if (qualified.length > 0) targets = qualified;
  }

  if (targets.length === 0) {
    const qualified = resolveSameClassBareCallFallback(call, caller.callerName, relPath, lookup);
    if (qualified.length > 0) targets = qualified;
  }

  if (targets.length === 0) {
    const qualified = resolveReflectionKeyExprFallback(
      call,
      caller.callerName,
      relPath,
      typeMap,
      lookup,
    );
    if (qualified.length > 0) targets = qualified;
  }

  if (targets.length === 0) {
    const qualified = resolveDefinePropertyAccessorFallback(
      call,
      caller.callerName,
      relPath,
      typeMap,
      lookup,
      definePropertyReceivers,
    );
    if (qualified.length > 0) targets = qualified;
  }

  // #1771/#1784: value-ref references (object-literal property values,
  // Lua builtin reassignment, `instanceof ClassName`) resolve against
  // function/method/class-kind targets only. A bare identifier in one of
  // these positions is as likely to be a plain data reference
  // (`{ name: SOME_CONSTANT }`) as a real function/class, so drop any
  // other-kind match rather than fabricating a "calls" edge to a constant.
  // `class` is included alongside function/method because `instanceof`'s
  // right operand is always a class/constructor (#1784) — unlike the
  // original #1771 object-literal case, which is function/method only.
  // Applied once here, after every fallback tier above, so it covers
  // whichever tier produced the match.
  if (call.dynamicKind === 'value-ref') {
    // `targets` is typed without `kind` when it flows straight through from
    // resolveCallTargets (call-resolver.ts's declared return type omits it),
    // but every underlying CallNodeLookup method actually populates it — the
    // same gap the preQualifiedTargets cast above already works around. Kept
    // as its own step (not folded into the filter callback) so the type-gap
    // workaround and the actual filtering decision stay visually distinct.
    const typedTargets = targets as ReadonlyArray<{ id: number; file: string; kind?: string }>;
    targets = typedTargets.filter(
      (t) => t.kind === 'function' || t.kind === 'method' || t.kind === 'class',
    );
  }

  return { targets, importedFrom };
}

/**
 * Emit direct-call edges for the resolved targets of a single call site.
 *
 * Sorts targets by confidence descending first, then for each target:
 *   - Skips self-edges and already-seen edges.
 *   - If a pts edge already exists for this pair, upgrades it in-place to
 *     direct-call confidence and promotes to seenCallEdges.
 *   - If a dyn=0 edge already exists and the incoming call has an explicit
 *     dynamicKind AND textually precedes the recorded dyn=0 call (e.g. a bare
 *     decorator `@Log` reordered after `@Log()` by the query path's
 *     query-then-walk collection — see buildFileCallEdges), upgrades the
 *     existing row to dyn=1 in-place so the earlier-in-source classification
 *     wins, matching what native's single-pass source-order walk produces
 *     natively.
 *   - Otherwise records a new `calls` edge with `ts-native` technique.
 */
function emitDirectCallEdgesForCall(
  caller: { id: number },
  targets: ReadonlyArray<{ id: number; file: string }>,
  importedFrom: string | null | undefined,
  isDynamic: number,
  hasDynamicKind: boolean,
  callLine: number,
  relPath: string,
  seenCallEdges: Set<string>,
  ptsEdgeRows: Map<string, number>,
  allEdgeRows: EdgeRowTuple[],
  dynZeroEdgeRows?: Map<string, DynZeroEdgeEntry>,
): void {
  // Sort targets by confidence descending before emitting edges.
  // For multi-target calls with duplicate (source_id, target_id) pairs the
  // stored confidence depends on which duplicate is processed last — sorting
  // here guarantees the highest-confidence target wins on dedup, matching the
  // native engine's sort_targets_by_confidence call in build_edges.rs.
  const sorted =
    targets.length > 1
      ? [...targets].sort(
          (a, b) =>
            computeConfidence(relPath, b.file, importedFrom ?? null) -
            computeConfidence(relPath, a.file, importedFrom ?? null),
        )
      : targets;

  for (const t of sorted) {
    const edgeKey = `${caller.id}|${t.id}`;
    if (t.id === caller.id) continue;
    const confidence = computeConfidence(relPath, t.file, importedFrom ?? null);
    if (seenCallEdges.has(edgeKey)) {
      // Edge already emitted. If the incoming call carries an explicit semantic
      // dynamic classification (dynamicKind set — e.g. 'reflection' for bare
      // decorators or .call/.apply/.bind) and the existing edge was recorded
      // with dyn=0, only upgrade it in-place when the incoming call's source
      // line is EARLIER than the recorded dyn=0 call's line.
      //
      // Why line order, not just "hasDynamicKind": the query path collects
      // calls in two phases — tree-sitter query matches (callfn_node/callmem_node,
      // true source order) first, then a supplementary walk pass for constructs
      // the query grammar can't capture (bare decorators, object-literal
      // value-refs) appended AFTERWARD regardless of true position (#1683).
      // A bare `@Log` at an earlier line can therefore reach this branch AFTER
      // `@Log()` at a later line already recorded dyn=0 — upgrading is correct
      // there because native's single-pass source-order walk would have seen
      // `@Log` first and kept dyn=1.
      //
      // But `.call/.apply/.bind` calls (e.g. `f(); f.call({})`, #1687/#1778) are
      // ordinary call_expressions collected in the SAME query phase as the
      // direct call, so true source order is already preserved: when the
      // dynamic-flavored call's line is LATER than the recorded dyn=0 call, it
      // is genuinely a second, later reference to the same target — native's
      // dedup (first-recorded-wins, no upgrade) drops it, so WASM must too.
      if (isDynamic === 1 && hasDynamicKind && dynZeroEdgeRows) {
        const dynZeroEntry = dynZeroEdgeRows.get(edgeKey);
        if (dynZeroEntry !== undefined && callLine < dynZeroEntry.line) {
          const row = allEdgeRows[dynZeroEntry.idx];
          if (row) row[4] = 1;
          dynZeroEdgeRows.delete(edgeKey);
        }
      }
      continue;
    }
    const ptsIdx = ptsEdgeRows.get(edgeKey);
    if (ptsIdx !== undefined) {
      // A pts-resolved edge already exists for this caller→target pair with a
      // penalised confidence. Upgrade it to the direct-call confidence in-place,
      // then promote to seenCallEdges so no further processing is needed.
      const ptsRow = allEdgeRows[ptsIdx];
      if (ptsRow) {
        ptsRow[3] = confidence;
        ptsRow[4] = isDynamic; // upgrade is_dynamic: direct call overrides the pts-alias dynamic flag
        ptsRow[5] = 'ts-native'; // promoted from pts to direct-call resolution
      }
      ptsEdgeRows.delete(edgeKey);
      seenCallEdges.add(edgeKey);
    } else {
      seenCallEdges.add(edgeKey);
      const newIdx = allEdgeRows.length;
      allEdgeRows.push([caller.id, t.id, 'calls', confidence, isDynamic, 'ts-native', null]);
      // Track dyn=0 edges (with their source line) so a later dyn=1+dynamicKind
      // call for the same pair can decide whether to upgrade them — see the
      // line-order comparison above (e.g. bare decorator reordered ahead of a
      // call-expression decorator by the query path, #1683).
      if (isDynamic === 0 && dynZeroEdgeRows) {
        dynZeroEdgeRows.set(edgeKey, { idx: newIdx, line: callLine });
      }
    }
  }
}

/**
 * Phase 8.3 / 8.3c / bind: emit pts-resolved edges for unresolved no-receiver calls.
 *
 * Fires for three cases:
 *   (a) dynamic=true: alias calls emitted by extractCallbackReferenceCalls.
 *       Looks up `call.name` directly (alias entries are flat-keyed).
 *   (b) non-dynamic: parameter variable calls (fn() where fn is a param).
 *       Looks up the scoped key `callerName::call.name` to avoid spurious
 *       edges from same-named parameters across different functions.
 *   (c) non-dynamic: module-level alias bindings — `f = fn.bind(ctx)` or
 *       `const f = handler` — where pts('f') was seeded by fnRefBindings.
 *       Checked against fnRefBindingLhs so case (c) only fires for genuine
 *       bind/alias entries and never for self-seeded local definitions.
 *
 * Pts edges are added to ptsEdgeRows (not seenCallEdges) so that a later
 * direct call to the same target can upgrade confidence rather than being
 * silently dropped by the dedup guard.
 */
function emitPtsNoReceiverEdges(
  call: Call,
  caller: { id: number; callerName: string | null },
  isDynamic: number,
  relPath: string,
  importedNames: Map<string, string>,
  lookup: CallNodeLookup,
  typeMap: Map<string, TypeMapEntry | string>,
  ptsMap: PointsToMap,
  fnRefBindingLhs: Set<string>,
  seenCallEdges: Set<string>,
  ptsEdgeRows: Map<string, number>,
  allEdgeRows: EdgeRowTuple[],
  importedOriginalNames?: ReadonlyMap<string, string>,
): void {
  const scopedPtsKey = caller.callerName != null ? `${caller.callerName}::${call.name}` : null;
  // Module-level calls (callerName === null) use the '<module>' sentinel emitted by
  // extractSpreadForOfWalk for top-level for-of loops. Look it up as a fallback so
  // that `for (const f of arr) { f(); }` at module scope resolves correctly.
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
    return;

  const ptsLookupName = call.dynamic
    ? call.name
    : scopedPtsKey != null && ptsMap.has(scopedPtsKey)
      ? scopedPtsKey
      : modulePtsKey != null
        ? modulePtsKey
        : // flatPtsKey != null is guaranteed: if neither call.dynamic nor scopedPtsKey
          // nor modulePtsKey matched, flatPtsKey must be non-null.
          flatPtsKey!;

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
          ptsEdgeRows.set(edgeKey, allEdgeRows.length);
          allEdgeRows.push([caller.id, t.id, 'calls', conf, isDynamic, 'points-to', null]);
        }
      }
    }
  }
}

/**
 * Phase 8.3f: emit pts-resolved edges for unresolved receiver calls via
 * object-rest param bindings.
 *
 * Fires when `rest.prop()` is encountered and `rest` was seeded as
 * `pts["rest.prop"]` by the object-rest dispatch chain
 * (ObjectRestParamBinding + paramBinding + ObjectPropBinding).
 */
function emitPtsReceiverEdges(
  call: Call,
  caller: { id: number; callerName: string | null },
  isDynamic: number,
  relPath: string,
  importedNames: Map<string, string>,
  lookup: CallNodeLookup,
  typeMap: Map<string, TypeMapEntry | string>,
  ptsMap: PointsToMap,
  seenCallEdges: Set<string>,
  ptsEdgeRows: Map<string, number>,
  allEdgeRows: EdgeRowTuple[],
  importedOriginalNames?: ReadonlyMap<string, string>,
): void {
  const receiverKey = `${call.receiver}.${call.name}`;
  if (!ptsMap.has(receiverKey)) return;

  for (const alias of resolveViaPointsTo(receiverKey, ptsMap)) {
    const { targets: aliasTargets, importedFrom: aliasFrom } = resolveCallTargets(
      lookup,
      { name: alias },
      relPath,
      importedNames,
      typeMap as Map<string, unknown>,
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
          ptsEdgeRows.set(edgeKey, allEdgeRows.length);
          allEdgeRows.push([caller.id, t.id, 'calls', conf, isDynamic, 'points-to', null]);
        }
      }
    }
  }
}

/**
 * Phase 8.5: emit CHA + RTA dispatch edges for a single call site.
 *
 * For `this`/`self`/`super` calls: resolve through the class hierarchy.
 * For typed receiver calls: expand to all instantiated concrete implementations.
 */
function emitChaCallEdgesForCall(
  call: Call,
  caller: { id: number; callerName: string | null },
  relPath: string,
  typeMap: Map<string, TypeMapEntry | string>,
  lookup: CallNodeLookup,
  chaCtx: ChaContext,
  seenCallEdges: Set<string>,
  ptsEdgeRows: Map<string, number>,
  allEdgeRows: EdgeRowTuple[],
): void {
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
  } else if (!BUILTIN_RECEIVERS.has(call.receiver!)) {
    const typeEntry = typeMap.get(call.receiver!);
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

  for (const t of chaTargets) {
    const edgeKey = `${caller.id}|${t.id}`;
    if (t.id !== caller.id && !seenCallEdges.has(edgeKey) && !ptsEdgeRows.has(edgeKey)) {
      // Typed-receiver (interface/CHA) dispatch: use CHA_TYPED_DISPATCH_CONFIDENCE
      // — file proximity is not meaningful for virtual dispatch confidence.
      // this/super dispatch keeps computeConfidence-based proximity scoring to
      // match runPostNativeThisDispatch (native-orchestrator.ts).
      const conf = isTypedReceiverDispatch
        ? CHA_TYPED_DISPATCH_CONFIDENCE
        : computeConfidence(relPath, t.file, null) - CHA_DISPATCH_PENALTY;
      if (conf > 0) {
        seenCallEdges.add(edgeKey);
        allEdgeRows.push([caller.id, t.id, 'calls', conf, 0, 'cha', null]);
      }
    }
  }
}

/**
 * Dynamic kinds that cannot be resolved statically — emit a sink edge to the
 * file node instead of silently dropping the call site.  confidence=0.0 keeps
 * these below DEFAULT_MIN_CONFIDENCE so they never appear in normal query results.
 * Includes reflection so that Reflect.apply/getMethod/callable-ref calls whose
 * target is not found in the codebase still produce a visible sink edge.
 */
const FLAG_ONLY_KINDS: ReadonlySet<DynamicKind> = new Set([
  'eval',
  'computed-key',
  'reflection',
  'unresolved-dynamic',
]);

/**
 * Build call edges for all calls in a single file (WASM/JS engine path).
 *
 * Iterates over `symbols.calls` and dispatches each call through the full
 * JS resolution cascade:
 *   1. `resolveFallbackTargets`  — primary + class-fallback + defineProperty fallback
 *   2. `emitDirectCallEdgesForCall` — emit direct-call edges (upgrading any pts pair)
 *   3. `emitPtsNoReceiverEdges`  — Phase 8.3/8.3c pts fallback for no-receiver calls
 *   4. `emitPtsReceiverEdges`    — Phase 8.3f pts fallback for rest-param receiver calls
 *   5. Inline `resolveReceiverEdge` — emit `receiver` edge for external receivers
 *   6. `emitChaCallEdgesForCall` — Phase 8.5 CHA + RTA dispatch expansion
 *   7. Sink edge for flag-only dynamic kinds (eval, computed-key, reflection, unresolved-dynamic)
 */
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
  chaCtx?: ChaContext,
  importArtifactNames?: ReadonlyMap<string, string>,
  importedOriginalNames?: ReadonlyMap<string, string>,
): void {
  // Tracks edges that were inserted by the pts fallback (edgeKey → allEdgeRows index).
  // Kept separate from seenCallEdges so that a subsequent direct-call edge for the same
  // caller→target pair can upgrade the confidence in-place rather than being silently
  // dropped by the dedup guard. Once upgraded, the key moves to seenCallEdges and is
  // no longer tracked here.
  const ptsEdgeRows = new Map<string, number>();

  // Tracks direct-call edges emitted with dyn=0 (edgeKey → { row index, source line }).
  // When a later call to the same target has dyn=1 and textually precedes the recorded
  // call (e.g. a bare decorator `@Log` reordered after the call-expression `@Log()` by
  // the query path, #1683), the existing dyn=0 row is upgraded in-place. See the line-order
  // comparison in emitDirectCallEdgesForCall for why line order (not mere dynamicKind
  // presence) gates the upgrade — this is also what keeps #1687/#1778 from regressing.
  const dynZeroEdgeRows = new Map<string, DynZeroEdgeEntry>();

  // Pre-compute the set of names that appear as lhs in fnRefBindings so that
  // case (c) of the pts gate below only fires for names that are genuine
  // bind/alias entries, not for every locally-defined function or import that
  // buildPointsToMap seeds with a self-pointing entry.
  const fnRefBindingLhs = new Set(symbols.fnRefBindings?.map((b) => b.lhs) ?? []);

  for (const call of symbols.calls) {
    if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;

    const caller = findCaller(lookup, call, symbols.definitions, relPath, fileNodeRow);
    const isDynamic: number = call.dynamic ? 1 : 0;

    // Step 1: Resolve targets with all JS-path fallbacks.
    const { targets, importedFrom } = resolveFallbackTargets(
      call,
      caller,
      relPath,
      importedNames,
      lookup,
      typeMap,
      symbols.definePropertyReceivers,
      importedOriginalNames,
    );

    // Step 2: Emit direct-call edges (upgrades any pending pts edge in-place).
    emitDirectCallEdgesForCall(
      caller,
      targets,
      importedFrom,
      isDynamic,
      !!call.dynamicKind,
      call.line,
      relPath,
      seenCallEdges,
      ptsEdgeRows,
      allEdgeRows,
      dynZeroEdgeRows,
    );

    // Step 3: Phase 8.3/8.3c pts fallback for unresolved no-receiver calls.
    if (targets.length === 0 && !call.receiver && ptsMap) {
      emitPtsNoReceiverEdges(
        call,
        caller,
        isDynamic,
        relPath,
        importedNames,
        lookup,
        typeMap,
        ptsMap,
        fnRefBindingLhs,
        seenCallEdges,
        ptsEdgeRows,
        allEdgeRows,
        importedOriginalNames,
      );
    }

    // Step 4: Phase 8.3f pts fallback for unresolved receiver calls (rest params).
    if (
      targets.length === 0 &&
      call.receiver &&
      !BUILTIN_RECEIVERS.has(call.receiver) &&
      call.receiver !== 'this' &&
      call.receiver !== 'self' &&
      call.receiver !== 'super' &&
      ptsMap
    ) {
      emitPtsReceiverEdges(
        call,
        caller,
        isDynamic,
        relPath,
        importedNames,
        lookup,
        typeMap,
        ptsMap,
        seenCallEdges,
        ptsEdgeRows,
        allEdgeRows,
        importedOriginalNames,
      );
    }

    // Step 5: Emit receiver edge for external (non-this/self/super) receivers.
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
        importArtifactNames ?? importedNames,
      );
      if (recv) {
        allEdgeRows.push([
          recv.callerId,
          recv.receiverId,
          'receiver',
          recv.confidence,
          0,
          null,
          null,
        ]);
      }
    }

    // Step 6: Phase 8.5 CHA + RTA dispatch expansion.
    if (chaCtx && call.receiver) {
      emitChaCallEdgesForCall(
        call,
        caller,
        relPath,
        typeMap,
        lookup,
        chaCtx,
        seenCallEdges,
        ptsEdgeRows,
        allEdgeRows,
      );
    }

    // Step 7: Flag-only dynamic kinds with no resolved target → sink edge to the
    // file node.  confidence=0.0 keeps it below DEFAULT_MIN_CONFIDENCE so it never
    // appears in normal query results, but is queryable via `codegraph roles --dynamic`.
    if (targets.length === 0 && call.dynamicKind && FLAG_ONLY_KINDS.has(call.dynamicKind)) {
      // Key per (caller, file, kind) so each kind gets at most one sink edge per caller.
      const sinkKey = `${caller.id}:${fileNodeRow.id}:${call.dynamicKind}`;
      if (!seenCallEdges.has(sinkKey)) {
        seenCallEdges.add(sinkKey);
        allEdgeRows.push([caller.id, fileNodeRow.id, 'calls', 0.0, 1, null, call.dynamicKind]);
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
          allEdgeRows.push([sourceRow.id, t.id, 'extends', 1.0, 0, null, null]);
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
          allEdgeRows.push([sourceRow.id, t.id, 'implements', 1.0, 0, null, null]);
        }
      }
    }
  }
}

// ── Native bulk-insert technique back-fill ──────────────────────────────

// Chunk-size-keyed statement caches for the technique/confidence backfill
// UPDATEs below, scoped per db like the batchInsertEdges/batchInsertNodes
// caches in builder/helpers.ts. Persisted across calls (not just loop
// iterations) because applyEdgeTechniquesAfterNativeInsert can run twice
// within a single buildEdges() invocation against the same db — once from
// insertNativeBulkEdges, once from reconnectReverseDepEdges — so caching
// per-call would still recompile on the second call (#1768).
const techniqueBackfillStmtCache = new WeakMap<
  BetterSqlite3Database,
  Map<number, SqliteStatement>
>();
const confidenceFloorStmtCache = new WeakMap<BetterSqlite3Database, Map<number, SqliteStatement>>();

/**
 * After native bulkInsertEdges (which does not write the technique column),
 * apply technique values from the in-memory row array back to the DB, and lift
 * any resolved ts-native edge below TS_NATIVE_CONFIDENCE_FLOOR to that floor.
 *
 * Rows with an explicit technique get a targeted UPDATE by (source_id, target_id).
 * The catch-all 'ts-native' tag is scoped to only the source_ids present in this
 * batch — this prevents mis-tagging pre-migration NULL-technique edges from
 * unchanged files that were never purged and re-inserted.
 */
function applyEdgeTechniquesAfterNativeInsert(
  db: BetterSqlite3Database,
  rows: EdgeRowTuple[],
): void {
  const callRows = rows.filter((r) => r[2] === 'calls');
  if (callRows.length === 0) return;

  const taggedRows = callRows.filter((r) => r[5] != null);
  // Collect distinct source IDs for this batch so the catch-all UPDATE is scoped
  // to edges inserted in the current run, not the entire table.
  const sourceIds = [...new Set(callRows.map((r) => r[0]))];
  // Chunk to stay within SQLite's SQLITE_LIMIT_VARIABLE_NUMBER (999 on older builds).
  const CHUNK_SIZE = 500;

  // Rows that carry an explicit dynamic_kind (sink edges for flagged dynamic calls).
  const dynamicKindRows = callRows.filter((r) => r[6] != null);

  const tx = db.transaction(() => {
    if (taggedRows.length > 0) {
      const stmt = db.prepare(
        "UPDATE edges SET technique = ? WHERE kind = 'calls' AND source_id = ? AND target_id = ? AND technique IS NULL",
      );
      for (const r of taggedRows) stmt.run(r[5], r[0], r[1]);
    }
    for (let i = 0; i < sourceIds.length; i += CHUNK_SIZE) {
      const chunk = sourceIds.slice(i, i + CHUNK_SIZE);
      const chunkSize = chunk.length;
      const techniqueStmt = getOrCreatePerDbChunkStmt(
        techniqueBackfillStmtCache,
        db,
        chunkSize,
        (n) =>
          `UPDATE edges SET technique = 'ts-native' WHERE kind = 'calls' AND technique IS NULL AND source_id IN (${Array.from({ length: n }, () => '?').join(',')})`,
      );
      techniqueStmt.run(...chunk);
      // Lift resolved ts-native edges below the confidence floor for this chunk.
      const confidenceStmt = getOrCreatePerDbChunkStmt(
        confidenceFloorStmtCache,
        db,
        chunkSize,
        (n) =>
          `UPDATE edges SET confidence = ?
         WHERE kind = 'calls' AND technique = 'ts-native'
           AND confidence > 0 AND confidence < ?
           AND source_id IN (${Array.from({ length: n }, () => '?').join(',')})`,
      );
      confidenceStmt.run(TS_NATIVE_CONFIDENCE_FLOOR, TS_NATIVE_CONFIDENCE_FLOOR, ...chunk);
    }
    // Back-fill dynamic_kind for flagged sink edges emitted by the native engine.
    // Native bulkInsertEdges uses INSERT OR IGNORE and does not write dynamic_kind, so
    // this UPDATE is the only way to set it for natively-inserted sink edges.
    //
    // Scope to confidence=0.0 AND dynamic=1 so we only touch sink edges (never normal
    // call edges that happen to share the same (source_id, target_id) pair).
    // Include dynamic_kind in the WHERE so two sink edges from the same caller to the
    // same file with different kinds don't clobber each other across incremental runs.
    if (dynamicKindRows.length > 0) {
      const stmt = db.prepare(
        "UPDATE edges SET dynamic_kind = ? WHERE kind = 'calls' AND source_id = ? AND target_id = ? AND confidence = 0.0 AND dynamic = 1 AND (dynamic_kind IS NULL OR dynamic_kind = ?)",
      );
      for (const r of dynamicKindRows) stmt.run(r[6], r[0], r[1], r[6]);
    }
  });
  tx();
}

// ── Reverse-dep edge reconnection (#932, #933) ─────────────────────────

/**
 * Picks the correct reconnect target among same-(name,kind,file) candidates
 * (sorted by ascending line).
 *
 * When only one candidate exists, it's an unambiguous match. When several
 * exist (e.g. multiple object-literal `close() {}` methods in one file) and
 * the sibling-group size is unchanged since save, the saved ordinal — the
 * target's rank by line among its siblings at save time — reliably
 * identifies the original target even though the whole group may have
 * shifted by an arbitrary number of lines. Falls back to nearest-line only
 * when the sibling count itself changed (a same-named sibling was added or
 * removed), since the ordinal mapping can no longer be trusted — see #1752.
 */
function pickReconnectTarget(
  candidates: Array<{ id: number; line: number }>,
  tgtOrdinal: number,
  tgtSiblingCount: number,
  tgtLine: number,
): number | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.id;
  if (candidates.length === tgtSiblingCount && tgtOrdinal >= 1 && tgtOrdinal <= candidates.length) {
    return candidates[tgtOrdinal - 1]!.id;
  }
  let best = candidates[0]!;
  let bestDist = Math.abs(best.line - tgtLine);
  for (const c of candidates) {
    const dist = Math.abs(c.line - tgtLine);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best.id;
}

/**
 * Reconnect edges that were saved before changed-file purge.
 *
 * Each saved edge records: sourceId (still valid — reverse-dep nodes were not
 * purged) and target attributes (name, kind, file, line, ordinal, sibling
 * count). The target node was deleted and re-inserted with a new ID by
 * insertNodes. We look up all (name, kind, file) candidates and pick the one
 * matching the saved ordinal (see `pickReconnectTarget`), then re-create the
 * edge.
 */
function reconnectReverseDepEdges(ctx: PipelineContext): void {
  const { db } = ctx;
  const candidatesStmt = db.prepare(
    'SELECT id, line FROM nodes WHERE name = ? AND kind = ? AND file = ? ORDER BY line',
  );
  const reconnectedRows: EdgeRowTuple[] = [];
  let dropped = 0;

  // Cache candidate lists per (name, kind, file) group — many saved edges
  // often share the same target (e.g. several callers of the same
  // function), so this avoids re-querying per edge.
  const candidatesCache = new Map<string, Array<{ id: number; line: number }>>();

  for (const saved of ctx.savedReverseDepEdges) {
    const cacheKey = `${saved.tgtName}|${saved.tgtKind}|${saved.tgtFile}`;
    let candidates = candidatesCache.get(cacheKey);
    if (!candidates) {
      candidates = candidatesStmt.all(saved.tgtName, saved.tgtKind, saved.tgtFile) as Array<{
        id: number;
        line: number;
      }>;
      candidatesCache.set(cacheKey, candidates);
    }

    const newId = pickReconnectTarget(
      candidates,
      saved.tgtOrdinal,
      saved.tgtSiblingCount,
      saved.tgtLine,
    );
    if (newId != null) {
      reconnectedRows.push([
        saved.sourceId,
        newId,
        saved.edgeKind,
        saved.confidence,
        saved.dynamic,
        saved.technique,
        saved.dynamicKind ?? null,
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
      } else {
        applyEdgeTechniquesAfterNativeInsert(db, reconnectedRows);
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
const NODE_KIND_FILTER_SQL = `kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant','variable')`;

function loadNodes(ctx: PipelineContext): { rows: QueryNodeRow[]; scoped: boolean } {
  const { db, fileSymbols, isFullBuild, batchResolved } = ctx;
  const nodeKindFilter = NODE_KIND_FILTER_SQL;

  // Gate: only scope for small incremental on large codebases
  if (!isFullBuild && fileSymbols.size <= ctx.config.build.smallFilesThreshold) {
    const existingFileCount = (
      db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get() as { c: number }
    ).c;
    if (existingFileCount > ctx.config.build.largeCodebaseFileThreshold) {
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

/** Load node-lookup structures used throughout edge construction (Phase 0 setup). */
function prepareNodeLookups(ctx: PipelineContext): {
  getNodeIdStmt: NodeIdStmt;
  allNodesBefore: QueryNodeRow[];
} {
  const getNodeIdStmt = makeGetNodeIdStmt(ctx.db);
  const { rows: allNodesBefore, scoped: scopedLoad } = loadNodes(ctx);
  setupNodeLookups(ctx, allNodesBefore);
  addLazyFallback(ctx, scopedLoad);
  return { getNodeIdStmt, allNodesBefore };
}

/**
 * Enrich typeMap for .ts/.tsx files using the TypeScript compiler API.
 * Runs before call-edge construction so the accurate types are available
 * for method-call resolution. Gated on config so users can opt out.
 *
 * Skip for small incremental builds: TypeScript program creation requires
 * loading the entire tsconfig file list (~700ms startup on the codegraph
 * corpus), which dominates the 1-file rebuild time. Native engine bypasses
 * this entirely via the Rust orchestrator; WASM/JS engines need this gate
 * to match native's effective behaviour on tiny incremental changes.
 * Mirrors the smallFilesThreshold gates for nativeDb and native call-edges.
 */
async function maybeEnrichTypeMapWithTsc(ctx: PipelineContext): Promise<void> {
  const isSmallIncremental =
    !ctx.isFullBuild && ctx.fileSymbols.size <= ctx.config.build.smallFilesThreshold;
  if (ctx.config.build.typescriptResolver && !isSmallIncremental) {
    await enrichTypeMapWithTsc(ctx.rootDir, ctx.fileSymbols);
  }
}

/**
 * Import-edge sub-phase: native fast path (with JS fallback for a #750-related
 * key-format mismatch) or the JS path directly.
 */
function buildImportEdgesPhase(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  native: NativeAddon | null,
): void {
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
}

/**
 * Call-edge sub-phase: native fast path (+ JS-only post-passes for
 * Object.defineProperty accessor dispatch and CHA/RTA expansion — capabilities
 * the native engine doesn't implement) or the full JS fallback path.
 */
function buildCallEdgesPhase(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
  allNodesBefore: QueryNodeRow[],
  native: NativeAddon | null,
  chaCtx: ChaContext,
): void {
  // Skip native call-edge path for small incremental builds: napi-rs
  // marshaling overhead for allNodes exceeds Rust computation savings.
  const useNativeCallEdges =
    native?.buildCallEdges &&
    (ctx.isFullBuild || ctx.fileSymbols.size > ctx.config.build.smallFilesThreshold);
  if (useNativeCallEdges) {
    buildCallEdgesNative(ctx, getNodeIdStmt, allEdgeRows, allNodesBefore, native!);
    // The native engine receives all pts bindings (paramBindings,
    // fnRefBindings, thisCallBindings, objectRestParamBindings, …) through
    // NativeFileEntry and runs the same points-to solver as the JS path, so
    // no pts post-passes are needed here. Only capabilities that remain
    // JS-only run as post-passes below.
    const sharedLookup = makeContextLookup(ctx, getNodeIdStmt);
    // Object.defineProperty accessor post-pass: resolve this-dispatch inside
    // getter/setter functions registered via Object.defineProperty.
    buildDefinePropertyPostPass(ctx, getNodeIdStmt, allEdgeRows, sharedLookup);
    // Phase 8.5 post-pass: augment native call edges with CHA-resolved dispatch.
    // The native Rust engine has no knowledge of the CHA context, so this/self
    // calls and interface dispatch are not expanded to concrete implementations.
    buildChaPostPass(ctx, getNodeIdStmt, allEdgeRows, chaCtx);
  } else {
    buildCallEdgesJS(ctx, getNodeIdStmt, allEdgeRows, chaCtx);
  }
}

/**
 * Apply the ts-native confidence floor to allEdgeRows in-memory.  The proximity
 * heuristic returns 0.3 for cross-module calls with no import-path evidence,
 * but both WASM and native engines perform actual name-based symbol lookup,
 * which is stronger evidence than pure proximity.  Clamping to
 * TS_NATIVE_CONFIDENCE_FLOOR (0.5) avoids unfairly dragging down the
 * call-confidence metric.  Sink edges (confidence = 0.0) are excluded so
 * they remain below DEFAULT_MIN_CONFIDENCE.
 */
function applyTsNativeConfidenceFloor(allEdgeRows: EdgeRowTuple[]): void {
  for (const r of allEdgeRows) {
    if (
      r[2] === 'calls' &&
      r[5] === 'ts-native' &&
      (r[3] as number) > 0 &&
      (r[3] as number) < TS_NATIVE_CONFIDENCE_FLOOR
    ) {
      r[3] = TS_NATIVE_CONFIDENCE_FLOOR;
    }
  }
}

/**
 * Phase 1: Compute edges inside a better-sqlite3 transaction.
 * Barrel-edge deletion lives here so that the JS path (which also inserts
 * edges in this transaction) keeps deletion + insertion atomic.
 * When using the native rusqlite path, insertion happens in Phase 2 on a
 * separate connection — a crash between Phase 1 and Phase 2 would leave
 * barrel edges missing until the next incremental rebuild re-creates them.
 */
function computeAndInsertEdges(
  ctx: PipelineContext,
  getNodeIdStmt: NodeIdStmt,
  allNodesBefore: QueryNodeRow[],
  native: NativeAddon | null,
  chaCtx: ChaContext,
): EdgeRowTuple[] {
  const { db } = ctx;
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

    buildImportEdgesPhase(ctx, getNodeIdStmt, allEdgeRows, native);
    buildCallEdgesPhase(ctx, getNodeIdStmt, allEdgeRows, allNodesBefore, native, chaCtx);
    applyTsNativeConfidenceFloor(allEdgeRows);

    // When using native edge insert, skip JS insert here — do it after tx commits.
    // Otherwise insert edges within this transaction for atomicity.
    const useNativeEdgeInsert = ctx.engineName === 'native' && !!ctx.nativeDb?.bulkInsertEdges;
    if (!useNativeEdgeInsert) {
      batchInsertEdges(db, allEdgeRows);
    }
  });
  computeEdgesTx();
  return allEdgeRows;
}

/**
 * Phase 2: Native rusqlite bulk insert (outside the better-sqlite3 transaction
 * to avoid SQLITE_BUSY contention). Uses the NativeDatabase persistent
 * connection. Standalone napi functions were removed in 6.17.
 */
function insertNativeBulkEdges(ctx: PipelineContext, allEdgeRows: EdgeRowTuple[]): void {
  if (!(ctx.engineName === 'native' && ctx.nativeDb?.bulkInsertEdges && allEdgeRows.length > 0)) {
    return;
  }
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
  } else {
    applyEdgeTechniquesAfterNativeInsert(ctx.db, allEdgeRows);
  }
}

export async function buildEdges(ctx: PipelineContext): Promise<void> {
  const { getNodeIdStmt, allNodesBefore } = prepareNodeLookups(ctx);

  const t0 = performance.now();

  await maybeEnrichTypeMapWithTsc(ctx);

  const native = ctx.engineName === 'native' ? loadNative() : null;

  // Phase 8.2: Augment typeMaps with cross-file return-type propagation before
  // the transaction opens. This is pure in-memory mutation (no DB I/O) and must
  // run outside the transaction to avoid leaving ctx.fileSymbols in a partial
  // state if the transaction rolls back unexpectedly.
  propagateReturnTypesAcrossFiles(ctx.fileSymbols, ctx, ctx.rootDir);
  // Phase 8.5: Build CHA context after propagation so typeMap confidence values
  // (used for RTA seeding) reflect any cross-file propagated types.
  const chaCtx = buildChaContext(ctx.fileSymbols);

  const allEdgeRows = computeAndInsertEdges(ctx, getNodeIdStmt, allNodesBefore, native, chaCtx);

  insertNativeBulkEdges(ctx, allEdgeRows);

  // Phase 3: Reconnect saved reverse-dep edges (#932, #933).
  // When the WASM/JS path purged changed files, edges FROM reverse-dep files TO
  // those files were deleted (target-side).  The reverse-dep files were NOT
  // reparsed — instead we saved the edge topology before purge and now reconnect
  // each edge to the new node IDs created by insertNodes.
  if (ctx.savedReverseDepEdges.length > 0) {
    reconnectReverseDepEdges(ctx);
  }

  // Phase 4: CHA post-pass — expand virtual-dispatch edges for class hierarchies
  // and interface implementations. Runs after all call + hierarchy edges are
  // committed so the DB is consistent.
  // Note: the native orchestrator success path runs this independently in
  // tryNativeOrchestrator; this phase covers the WASM and native-fallback paths.
  runChaPostPass(ctx.db);

  ctx.timing.edgesMs = performance.now() - t0;
}
