/**
 * Stage: buildEdges
 *
 * Builds import, call, receiver, extends, and implements edges.
 * Uses pre-loaded node lookup maps (N+1 optimization).
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type BetterSqlite3 from 'better-sqlite3';
import { getNodeId } from '../../../../db/index.js';
import { loadNative } from '../../../../infrastructure/native.js';
import type {
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

/** TypeMap entry used in receiver supplement (normalized from native format). */
interface NormalizedTypeEntry {
  type: string;
  confidence: number;
}

// ── Node lookup setup ───────────────────────────────────────────────────

function makeGetNodeIdStmt(db: BetterSqlite3.Database): NodeIdStmt {
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

  // Older native binaries (< 3.2.0) don't emit receiver or type-resolved method-call
  // edges. Supplement them on the JS side if the native binary missed them.
  // TODO: Remove once all published native binaries handle receivers (>= 3.2.0)
  const hasReceiver = nativeEdges.some((e) => e.kind === 'receiver');
  if (!hasReceiver) {
    supplementReceiverEdges(ctx, nativeFiles, getNodeIdStmt, allEdgeRows);
  }
}

function buildImportedNamesForNative(
  ctx: PipelineContext,
  relPath: string,
  symbols: ExtractorOutput,
  rootDir: string,
): Array<{ name: string; file: string }> {
  const importedNames: Array<{ name: string; file: string }> = [];
  for (const imp of symbols.imports) {
    const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
    for (const name of imp.names) {
      const cleanName = name.replace(/^\*\s+as\s+/, '');
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

// ── Receiver edge supplement for older native binaries ──────────────────

function supplementReceiverEdges(
  ctx: PipelineContext,
  nativeFiles: NativeFileEntry[],
  getNodeIdStmt: NodeIdStmt,
  allEdgeRows: EdgeRowTuple[],
): void {
  const seenCallEdges = new Set<string>();
  // Collect existing edges to avoid duplicates
  for (const row of allEdgeRows) {
    seenCallEdges.add(`${row[0]}|${row[1]}|${row[2]}`);
  }

  for (const nf of nativeFiles) {
    const relPath = nf.file;
    const typeMap = new Map<string, NormalizedTypeEntry>(
      nf.typeMap.map((t) => [t.name, { type: t.typeName, confidence: t.confidence ?? 0.9 }]),
    );
    const fileNodeRow = { id: nf.fileNodeId };

    for (const call of nf.calls) {
      if (!call.receiver || BUILTIN_RECEIVERS.has(call.receiver)) continue;
      if (call.receiver === 'this' || call.receiver === 'self' || call.receiver === 'super')
        continue;

      const caller = findCaller(call, nf.definitions, relPath, getNodeIdStmt, fileNodeRow);

      // Receiver edge: caller → receiver type node
      buildReceiverEdge(ctx, call, caller, relPath, seenCallEdges, allEdgeRows, typeMap);

      // Type-resolved method call: caller → Type.method
      const typeEntry = typeMap.get(call.receiver);
      const typeName = typeEntry ? typeEntry.type : null;
      if (typeName) {
        const qualifiedName = `${typeName}.${call.name}`;
        const targets = (ctx.nodesByName.get(qualifiedName) || []).filter(
          (n) => n.kind === 'method',
        );
        for (const t of targets) {
          const key = `${caller.id}|${t.id}|calls`;
          if (t.id !== caller.id && !seenCallEdges.has(key)) {
            seenCallEdges.add(key);
            const confidence = computeConfidence(relPath, t.file, null);
            allEdgeRows.push([caller.id, t.id, 'calls', confidence, call.dynamic ? 1 : 0]);
          }
        }
      }
    }
  }
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
      importedNames.set(name.replace(/^\*\s+as\s+/, ''), resolvedPath);
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
  typeMap: Map<string, TypeMapEntry | NormalizedTypeEntry | string>,
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

export async function buildEdges(ctx: PipelineContext): Promise<void> {
  const { db, engineName } = ctx;

  const getNodeIdStmt = makeGetNodeIdStmt(db);

  const allNodes = db
    .prepare(
      `SELECT id, name, kind, file, line FROM nodes WHERE kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant')`,
    )
    .all() as QueryNodeRow[];
  setupNodeLookups(ctx, allNodes);

  const t0 = performance.now();
  const buildEdgesTx = db.transaction(() => {
    // Delete stale outgoing edges for barrel-only files inside the transaction
    // so that deletion and re-creation are atomic (no edge loss on mid-build crash).
    if (ctx.barrelOnlyFiles.size > 0) {
      const deleteOutgoingEdges = db.prepare(
        'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
      );
      for (const relPath of ctx.barrelOnlyFiles) {
        deleteOutgoingEdges.run(relPath);
      }
    }

    const allEdgeRows: EdgeRowTuple[] = [];

    buildImportEdges(ctx, getNodeIdStmt, allEdgeRows);

    const native = engineName === 'native' ? loadNative() : null;
    if (native?.buildCallEdges) {
      buildCallEdgesNative(ctx, getNodeIdStmt, allEdgeRows, allNodes, native);
    } else {
      buildCallEdgesJS(ctx, getNodeIdStmt, allEdgeRows);
    }

    batchInsertEdges(db, allEdgeRows);
  });
  buildEdgesTx();
  ctx.timing.edgesMs = performance.now() - t0;
}
