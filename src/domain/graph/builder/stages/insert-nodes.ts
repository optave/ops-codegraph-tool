/**
 * Stage: insertNodes
 *
 * Batch-inserts file nodes, definitions, exports, children, and contains/parameter_of edges.
 * Updates file hashes for incremental builds.
 *
 * When the native engine is available, delegates all SQLite writes to Rust via
 * `bulkInsertNodes` — eliminating JS↔C boundary overhead. Falls back to the
 * JS implementation on failure or when native is unavailable.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { bulkNodeIdsByFile } from '../../../../db/index.js';
import { debug } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
import { toErrorMessage } from '../../../../shared/errors.js';
import type {
  BetterSqlite3Database,
  ExtractorOutput,
  FileToParse,
  MetadataUpdate,
  SqliteStatement,
} from '../../../../types.js';
import type { PipelineContext } from '../context.js';
import {
  batchInsertEdges,
  batchInsertNodes,
  fileHash,
  fileStat,
  markExportedSymbols,
  readFileSafe,
} from '../helpers.js';

/** Shape of precomputed file data gathered from filesToParse entries. */
interface PrecomputedFileData {
  file: string;
  relPath?: string;
  content?: string;
  hash?: string;
  stat?: { mtime: number; size: number } | null;
  _reverseDepOnly?: boolean;
}

// ── Native fast-path helpers ─────────────────────────────────────────

/** Shape of a marshaled batch for native bulk insert. */
interface InsertNodesBatch {
  file: string;
  definitions: Array<{
    name: string;
    kind: string;
    line: number;
    endLine?: number;
    visibility?: string;
    children: Array<{
      name: string;
      kind: string;
      line: number;
      endLine?: number;
      visibility?: string;
    }>;
  }>;
  exports: Array<{ name: string; kind: string; line: number }>;
}

/** Marshal allSymbols into the batch format expected by native bulkInsertNodes. */
function marshalSymbolBatches(allSymbols: Map<string, ExtractorOutput>): InsertNodesBatch[] {
  const batches: InsertNodesBatch[] = [];
  for (const [relPath, symbols] of allSymbols) {
    batches.push({
      file: relPath,
      definitions: symbols.definitions.map((def) => ({
        name: def.name,
        kind: def.kind,
        line: def.line,
        endLine: def.endLine ?? undefined,
        visibility: def.visibility ?? undefined,
        children: (def.children ?? []).map((c) => ({
          name: c.name,
          kind: c.kind,
          line: c.line,
          endLine: c.endLine ?? undefined,
          visibility: c.visibility ?? undefined,
        })),
      })),
      exports: symbols.exports.map((exp) => ({
        name: exp.name,
        kind: exp.kind,
        line: exp.line,
      })),
    });
  }
  return batches;
}

/** A single file_hashes row. */
interface FileHashRecord {
  file: string;
  hash: string;
  mtime: number;
  size: number;
}

/** Resolve the (hash, mtime, size) tuple for a relPath, reading from disk if needed. */
function resolveHashFromPrecomputed(
  relPath: string,
  precomputed: PrecomputedFileData,
  rootDir: string,
  caller: string,
): FileHashRecord | null {
  if (precomputed.hash) {
    let mtime: number;
    let size: number;
    if (precomputed.stat) {
      mtime = precomputed.stat.mtime;
      size = precomputed.stat.size;
    } else {
      const rawStat = fileStat(path.join(rootDir, relPath));
      mtime = rawStat ? rawStat.mtime : 0;
      size = rawStat ? rawStat.size : 0;
    }
    return { file: relPath, hash: precomputed.hash, mtime, size };
  }

  const absPath = path.join(rootDir, relPath);
  let code: string | null;
  try {
    code = readFileSafe(absPath);
  } catch (e) {
    debug(`${caller}: readFileSafe failed for ${relPath}: ${toErrorMessage(e)}`);
    code = null;
  }
  if (code === null) return null;
  const stat = fileStat(absPath);
  return {
    file: relPath,
    hash: fileHash(code),
    mtime: stat ? stat.mtime : 0,
    size: stat ? stat.size : 0,
  };
}

/**
 * Walk every collected file once and yield a `FileHashRecord` for it, plus one
 * record per metadata-only update.  Shared by `buildFileHashes` (native path)
 * and `updateFileHashes` (JS fallback) so the iteration and hash-resolution
 * logic stays in one place.
 *
 * Files marked `_reverseDepOnly` are skipped — their hashes are already
 * correct in the DB.
 */
function* iterFileHashRecords(
  filesToParse: FileToParse[],
  precomputedData: Map<string, PrecomputedFileData>,
  metadataUpdates: MetadataUpdate[],
  rootDir: string,
  caller: string,
): Generator<FileHashRecord> {
  const seen = new Set<string>();

  for (const item of filesToParse) {
    const relPath = item.relPath ?? normalizePath(path.relative(rootDir, item.file));
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const precomputed = precomputedData.get(relPath);
    if (precomputed?._reverseDepOnly) continue;

    const record = resolveHashFromPrecomputed(
      relPath,
      precomputed ?? ({} as PrecomputedFileData),
      rootDir,
      caller,
    );
    if (record) yield record;
  }

  // Metadata-only updates (self-heal mtime/size without re-parse)
  for (const item of metadataUpdates) {
    yield {
      file: item.relPath,
      hash: item.hash,
      mtime: item.stat ? item.stat.mtime : 0,
      size: item.stat ? item.stat.size : 0,
    };
  }
}

/**
 * Build file hash entries for every collected file, including those that
 * produced zero symbols (empty files, parsers that silently no-op'd, or
 * optional-language extensions whose grammar wasn't installed). Iterating the
 * symbol map instead would skip such files and leave them missing from
 * `file_hashes`, which permanently breaks the JS-side fast-skip pre-flight on
 * any subsequent no-op rebuild (#1068).
 *
 * Exported for unit testing.
 */
export function buildFileHashes(
  filesToParse: FileToParse[],
  precomputedData: Map<string, PrecomputedFileData>,
  metadataUpdates: MetadataUpdate[],
  rootDir: string,
): FileHashRecord[] {
  return [
    ...iterFileHashRecords(
      filesToParse,
      precomputedData,
      metadataUpdates,
      rootDir,
      'buildFileHashes',
    ),
  ];
}

// ── Native fast-path ─────────────────────────────────────────────────

function tryNativeInsert(ctx: PipelineContext): boolean {
  if (!ctx.nativeDb?.bulkInsertNodes) return false;

  const { allSymbols, filesToParse, metadataUpdates, rootDir, removed } = ctx;

  const batches = marshalSymbolBatches(allSymbols);

  const precomputedData = new Map<string, PrecomputedFileData>();
  for (const item of filesToParse) {
    if (item.relPath) precomputedData.set(item.relPath, item as PrecomputedFileData);
  }
  const fileHashes = buildFileHashes(filesToParse, precomputedData, metadataUpdates, rootDir);

  // In native-first mode (single rusqlite connection), no WAL dance is needed.
  // In dual-connection mode, checkpoint JS side before native write, then
  // checkpoint native side after (#696, #709, #715, #717).
  let result: boolean;
  if (ctx.nativeFirstProxy) {
    result = ctx.nativeDb!.bulkInsertNodes(batches, fileHashes, removed);
  } else {
    try {
      if (ctx.db) {
        ctx.db.pragma('wal_checkpoint(TRUNCATE)');
      }
      result = ctx.nativeDb!.bulkInsertNodes(batches, fileHashes, removed);
    } finally {
      try {
        ctx.nativeDb?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (e) {
        debug(
          `tryNativeInsert: WAL checkpoint failed (nativeDb may already be closed): ${toErrorMessage(e)}`,
        );
      }
    }
  }
  return result;
}

// ── JS fallback: Phase 1 ────────────────────────────────────────────

function insertDefinitionsAndExports(
  db: BetterSqlite3Database,
  allSymbols: Map<string, ExtractorOutput>,
): void {
  const phase1Rows: unknown[][] = [];
  const exportKeys: unknown[][] = [];
  for (const [relPath, symbols] of allSymbols) {
    phase1Rows.push([relPath, 'file', relPath, 0, null, null, null, null, null]);
    for (const def of symbols.definitions) {
      const dotIdx = def.name.lastIndexOf('.');
      const scope = dotIdx !== -1 ? def.name.slice(0, dotIdx) : null;
      phase1Rows.push([
        def.name,
        def.kind,
        relPath,
        def.line,
        def.endLine || null,
        null,
        def.name,
        scope,
        def.visibility || null,
      ]);
    }
    for (const exp of symbols.exports) {
      phase1Rows.push([exp.name, exp.kind, relPath, exp.line, null, null, exp.name, null, null]);
      exportKeys.push([exp.name, exp.kind, relPath, exp.line]);
    }
  }
  batchInsertNodes(db, phase1Rows);
  markExportedSymbols(db, exportKeys);
}

// ── JS fallback: Phase 2+3 ──────────────────────────────────────────

/** Build the in-memory `name|kind|line` → node-id map for a single file. */
function loadFileNodeIdMap(db: BetterSqlite3Database, relPath: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of bulkNodeIdsByFile(db, relPath)) {
    map.set(`${row.name}|${row.kind}|${row.line}`, row.id);
  }
  return map;
}

/**
 * First pass: for every file, emit file→def containment edges and collect
 * the child-node insertion rows.
 */
function collectChildRowsAndFileEdges(
  db: BetterSqlite3Database,
  allSymbols: Map<string, ExtractorOutput>,
  childRows: unknown[][],
  edgeRows: unknown[][],
): void {
  for (const [relPath, symbols] of allSymbols) {
    const nodeIdMap = loadFileNodeIdMap(db, relPath);
    const fileId = nodeIdMap.get(`${relPath}|file|0`);

    for (const def of symbols.definitions) {
      const defId = nodeIdMap.get(`${def.name}|${def.kind}|${def.line}`);

      if (fileId && defId) {
        edgeRows.push([fileId, defId, 'contains', 1.0, 0]);
      }
      if (!def.children?.length || !defId) continue;

      for (const child of def.children) {
        childRows.push([
          child.name,
          child.kind,
          relPath,
          child.line,
          child.endLine || null,
          defId,
          `${def.name}.${child.name}`,
          def.name,
          child.visibility || null,
        ]);
      }
    }
  }
}

/**
 * Second pass (after child nodes have been inserted): emit def→child
 * containment edges and child→def `parameter_of` edges.
 */
function collectChildEdges(
  db: BetterSqlite3Database,
  allSymbols: Map<string, ExtractorOutput>,
  edgeRows: unknown[][],
): void {
  for (const [relPath, symbols] of allSymbols) {
    const nodeIdMap = loadFileNodeIdMap(db, relPath);
    for (const def of symbols.definitions) {
      if (!def.children?.length) continue;
      const defId = nodeIdMap.get(`${def.name}|${def.kind}|${def.line}`);
      if (!defId) continue;
      for (const child of def.children) {
        const childId = nodeIdMap.get(`${child.name}|${child.kind}|${child.line}`);
        if (!childId) continue;
        edgeRows.push([defId, childId, 'contains', 1.0, 0]);
        if (child.kind === 'parameter') {
          edgeRows.push([childId, defId, 'parameter_of', 1.0, 0]);
        }
      }
    }
  }
}

function insertChildrenAndEdges(
  db: BetterSqlite3Database,
  allSymbols: Map<string, ExtractorOutput>,
): void {
  const childRows: unknown[][] = [];
  const edgeRows: unknown[][] = [];

  collectChildRowsAndFileEdges(db, allSymbols, childRows, edgeRows);

  // Insert children first (so they exist for edge lookup)
  batchInsertNodes(db, childRows);

  collectChildEdges(db, allSymbols, edgeRows);
  batchInsertEdges(db, edgeRows);
}

// ── JS fallback: Phase 4 ────────────────────────────────────────────

function updateFileHashes(
  _db: BetterSqlite3Database,
  filesToParse: FileToParse[],
  precomputedData: Map<string, PrecomputedFileData>,
  metadataUpdates: MetadataUpdate[],
  rootDir: string,
  upsertHash: SqliteStatement | null,
): void {
  if (!upsertHash) return;

  // Iterate every collected file (#1068): files that produced zero symbols
  // (empty, parser no-op, or grammar-missing optional language) still need a
  // hash row, otherwise the next no-op rebuild's fast-skip pre-flight rejects.
  for (const record of iterFileHashRecords(
    filesToParse,
    precomputedData,
    metadataUpdates,
    rootDir,
    'updateFileHashes',
  )) {
    upsertHash.run(record.file, record.hash, record.mtime, record.size);
  }
}

// ── Main entry point ────────────────────────────────────────────────

export async function insertNodes(ctx: PipelineContext): Promise<void> {
  const { allSymbols, filesToParse, metadataUpdates, rootDir, removed } = ctx;

  // Populate fileSymbols before any DB writes (used by later stages)
  for (const [relPath, symbols] of allSymbols) {
    ctx.fileSymbols.set(relPath, symbols);
  }

  const t0 = performance.now();

  // Try native Rust path first — single transaction, no JS↔C overhead
  if (ctx.engineName === 'native') {
    try {
      if (tryNativeInsert(ctx)) {
        ctx.timing.insertMs = performance.now() - t0;
        // Removed-file hash cleanup is handled inside the native call
        return;
      }
    } catch (e) {
      debug(`insertNodes: native insert failed, falling back to JS: ${toErrorMessage(e)}`);
    }
  }

  // JS fallback
  const precomputedData = new Map<string, PrecomputedFileData>();
  for (const item of filesToParse) {
    if (item.relPath) precomputedData.set(item.relPath, item as PrecomputedFileData);
  }

  let upsertHash: SqliteStatement | null;
  try {
    upsertHash = ctx.db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
  } catch (e) {
    debug(`insertNodes: file_hashes prepare failed (table may not exist): ${toErrorMessage(e)}`);
    upsertHash = null;
  }

  const insertAll = ctx.db.transaction(() => {
    insertDefinitionsAndExports(ctx.db, allSymbols);
    insertChildrenAndEdges(ctx.db, allSymbols);
    updateFileHashes(ctx.db, filesToParse, precomputedData, metadataUpdates, rootDir, upsertHash);
  });

  insertAll();
  ctx.timing.insertMs = performance.now() - t0;

  // Clean up removed file hashes
  if (upsertHash && removed.length > 0) {
    const deleteHash = ctx.db.prepare('DELETE FROM file_hashes WHERE file = ?');
    for (const relPath of removed) {
      deleteHash.run(relPath);
    }
  }
}
