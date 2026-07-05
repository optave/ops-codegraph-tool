/**
 * Stage: insertNodes
 *
 * Batch-inserts file nodes, definitions, exports, children, and contains/parameter_of edges.
 *
 * When the native engine is available, delegates all SQLite writes to Rust via
 * `bulkInsertNodes` — eliminating JS↔C boundary overhead. Falls back to the
 * JS implementation on failure or when native is unavailable.
 *
 * Does NOT write file_hashes for changed files (only removed-file cleanup,
 * which carries no coupling risk — see commitFileHashes below). Hashes for
 * changed files are committed later, once resolveImports/buildEdges have
 * finished rebuilding their edges, so a hash can never claim a file is
 * "up to date" while its edges still reflect an older revision (#1731).
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

  const { allSymbols, removed } = ctx;

  const batches = marshalSymbolBatches(allSymbols);

  // file_hashes is intentionally NOT written here. Committing a file's hash
  // this early (before resolveImports/buildEdges have run) would let the
  // hash claim "up to date" even if edge-building later throws or is
  // interrupted — see commitFileHashes below, called once edges are in
  // place (#1731). `removed` is still passed through: deleting a removed
  // file's hash has no such coupling risk (the file has no edges to keep
  // in sync with).
  let result: boolean;
  if (ctx.nativeFirstProxy) {
    result = ctx.nativeDb!.bulkInsertNodes(batches, [], removed);
  } else {
    try {
      if (ctx.db) {
        ctx.db.pragma('wal_checkpoint(TRUNCATE)');
      }
      result = ctx.nativeDb!.bulkInsertNodes(batches, [], removed);
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

// ── Main entry point ────────────────────────────────────────────────

export async function insertNodes(ctx: PipelineContext): Promise<void> {
  const { allSymbols, removed } = ctx;

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
        // Removed-file hash cleanup is handled inside the native call.
        // Content-changed files' hashes are committed later by
        // commitFileHashes(), once their edges exist (#1731).
        return;
      }
    } catch (e) {
      debug(`insertNodes: native insert failed, falling back to JS: ${toErrorMessage(e)}`);
    }
  }

  // JS fallback — node/edge insertion only. file_hashes for changed files is
  // intentionally NOT written here: see commitFileHashes() below (#1731).
  const insertAll = ctx.db.transaction(() => {
    insertDefinitionsAndExports(ctx.db, allSymbols);
    insertChildrenAndEdges(ctx.db, allSymbols);
  });

  insertAll();
  ctx.timing.insertMs = performance.now() - t0;

  // Clean up removed file hashes. Safe to do immediately (unlike the upsert
  // path): a removed file has no edges that need to stay in sync with its hash.
  if (removed.length > 0) {
    try {
      const deleteHash = ctx.db.prepare('DELETE FROM file_hashes WHERE file = ?');
      for (const relPath of removed) {
        deleteHash.run(relPath);
      }
    } catch (e) {
      debug(
        `insertNodes: removed-file hash cleanup failed (table may not exist): ${toErrorMessage(e)}`,
      );
    }
  }
}

// ── Deferred file_hashes commit ──────────────────────────────────────

/**
 * Commit `file_hashes` for every changed/parsed file, plus metadata-only
 * healing entries. Called by the pipeline strictly AFTER resolveImports and
 * buildEdges have finished rebuilding those files' edges.
 *
 * This is the fix for #1731: previously, `insertNodes` wrote file_hashes in
 * the same transaction as node insertion — BEFORE resolveImports/buildEdges
 * ran. Any exception, crash, or interruption between that write and the
 * (separate) edge-building transaction(s) left the DB with a hash that
 * claimed "up to date" while edges still reflected the previous revision (or
 * were missing entirely) — and since change-detection trusts file_hashes
 * exclusively, that divergence was never self-healed by later builds.
 *
 * Deferring the write here restores the invariant: a file's hash only ever
 * advances once its edges have been rebuilt to match. If anything upstream
 * throws before this point, the hash keeps its old value, so the next build
 * correctly detects the file as still needing (re)processing.
 */
export function commitFileHashes(ctx: PipelineContext): void {
  const { filesToParse, metadataUpdates, rootDir } = ctx;

  const precomputedData = new Map<string, PrecomputedFileData>();
  for (const item of filesToParse) {
    if (item.relPath) precomputedData.set(item.relPath, item as PrecomputedFileData);
  }
  const fileHashes = buildFileHashes(filesToParse, precomputedData, metadataUpdates, rootDir);
  if (fileHashes.length === 0) return;

  if (ctx.engineName === 'native' && ctx.nativeDb?.healFileMetadata) {
    try {
      ctx.nativeDb.healFileMetadata(fileHashes);
    } catch (e) {
      debug(`commitFileHashes: native healFileMetadata failed: ${toErrorMessage(e)}`);
    }
    return;
  }

  try {
    const upsertHash = ctx.db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
    const commitTx = ctx.db.transaction(() => {
      for (const record of fileHashes) {
        upsertHash.run(record.file, record.hash, record.mtime, record.size);
      }
    });
    commitTx();
  } catch (e) {
    debug(`commitFileHashes: file_hashes write failed (table may not exist): ${toErrorMessage(e)}`);
  }
}
