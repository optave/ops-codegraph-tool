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
import { loadNative } from '../../../../infrastructure/native.js';
import type {
  BetterSqlite3Database,
  ExtractorOutput,
  MetadataUpdate,
  SqliteStatement,
} from '../../../../types.js';
import type { PipelineContext } from '../context.js';
import {
  batchInsertEdges,
  batchInsertNodes,
  fileHash,
  fileStat,
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

// ── Native fast-path ─────────────────────────────────────────────────

function tryNativeInsert(ctx: PipelineContext): boolean {
  // Prefer NativeDatabase persistent connection (6.15), fall back to standalone (6.12)
  const hasNativeDb = !!ctx.nativeDb?.bulkInsertNodes;
  const native = hasNativeDb ? null : loadNative();
  if (!hasNativeDb && !native?.bulkInsertNodes) return false;

  const { dbPath, allSymbols, filesToParse, metadataUpdates, rootDir, removed } = ctx;
  if (!hasNativeDb && !dbPath) return false;

  // Marshal allSymbols → InsertNodesBatch[]
  const batches: Array<{
    file: string;
    definitions: Array<{
      name: string;
      kind: string;
      line: number;
      endLine?: number | null;
      visibility?: string | null;
      children: Array<{
        name: string;
        kind: string;
        line: number;
        endLine?: number | null;
        visibility?: string | null;
      }>;
    }>;
    exports: Array<{ name: string; kind: string; line: number }>;
  }> = [];

  for (const [relPath, symbols] of allSymbols) {
    batches.push({
      file: relPath,
      definitions: symbols.definitions.map((def) => ({
        name: def.name,
        kind: def.kind,
        line: def.line,
        endLine: def.endLine ?? null,
        visibility: def.visibility ?? null,
        children: (def.children ?? []).map((c) => ({
          name: c.name,
          kind: c.kind,
          line: c.line,
          endLine: c.endLine ?? null,
          visibility: c.visibility ?? null,
        })),
      })),
      exports: symbols.exports.map((exp) => ({
        name: exp.name,
        kind: exp.kind,
        line: exp.line,
      })),
    });
  }

  // Build file hash entries
  const precomputedData = new Map<string, PrecomputedFileData>();
  for (const item of filesToParse) {
    if (item.relPath) precomputedData.set(item.relPath, item as PrecomputedFileData);
  }

  const fileHashes: Array<{ file: string; hash: string; mtime: number; size: number }> = [];
  for (const [relPath] of allSymbols) {
    const precomputed = precomputedData.get(relPath);
    if (precomputed?._reverseDepOnly) {
      continue; // file unchanged, hash already correct
    }
    if (precomputed?.hash) {
      let mtime: number;
      let size: number;
      if (precomputed.stat) {
        mtime = precomputed.stat.mtime;
        size = precomputed.stat.size;
      } else {
        const rawStat = fileStat(path.join(rootDir, relPath));
        mtime = rawStat ? Math.floor(rawStat.mtimeMs) : 0;
        size = rawStat ? rawStat.size : 0;
      }
      fileHashes.push({ file: relPath, hash: precomputed.hash, mtime, size });
    } else {
      const absPath = path.join(rootDir, relPath);
      let code: string | null;
      try {
        code = readFileSafe(absPath);
      } catch {
        code = null;
      }
      if (code !== null) {
        const stat = fileStat(absPath);
        const mtime = stat ? Math.floor(stat.mtimeMs) : 0;
        const size = stat ? stat.size : 0;
        fileHashes.push({ file: relPath, hash: fileHash(code), mtime, size });
      }
    }
  }

  // Also include metadata-only updates (self-heal mtime/size without re-parse)
  for (const item of metadataUpdates) {
    const mtime = item.stat ? Math.floor(item.stat.mtime) : 0;
    const size = item.stat ? item.stat.size : 0;
    fileHashes.push({ file: item.relPath, hash: item.hash, mtime, size });
  }

  // Route through persistent NativeDatabase when available (6.15)
  if (ctx.nativeDb?.bulkInsertNodes) {
    return ctx.nativeDb.bulkInsertNodes(batches, fileHashes, removed);
  }
  return native!.bulkInsertNodes(dbPath!, batches, fileHashes, removed);
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

  // Mark exported symbols in batches (cache prepared statements by chunk size)
  if (exportKeys.length > 0) {
    const EXPORT_CHUNK = 500;
    const exportStmtCache = new Map<number, SqliteStatement>();
    for (let i = 0; i < exportKeys.length; i += EXPORT_CHUNK) {
      const end = Math.min(i + EXPORT_CHUNK, exportKeys.length);
      const chunkSize = end - i;
      let updateStmt = exportStmtCache.get(chunkSize);
      if (!updateStmt) {
        const conditions = Array.from(
          { length: chunkSize },
          () => '(name = ? AND kind = ? AND file = ? AND line = ?)',
        ).join(' OR ');
        updateStmt = db.prepare(`UPDATE nodes SET exported = 1 WHERE ${conditions}`);
        exportStmtCache.set(chunkSize, updateStmt);
      }
      const vals: unknown[] = [];
      for (let j = i; j < end; j++) {
        const k = exportKeys[j] as unknown[];
        vals.push(k[0], k[1], k[2], k[3]);
      }
      updateStmt.run(...vals);
    }
  }
}

// ── JS fallback: Phase 2+3 ──────────────────────────────────────────

function insertChildrenAndEdges(
  db: BetterSqlite3Database,
  allSymbols: Map<string, ExtractorOutput>,
): void {
  const childRows: unknown[][] = [];
  const edgeRows: unknown[][] = [];

  for (const [relPath, symbols] of allSymbols) {
    // First pass: collect file→def edges and child rows
    const nodeIdMap = new Map<string, number>();
    for (const row of bulkNodeIdsByFile(db, relPath)) {
      nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
    }

    const fileId = nodeIdMap.get(`${relPath}|file|0`);

    for (const def of symbols.definitions) {
      const defId = nodeIdMap.get(`${def.name}|${def.kind}|${def.line}`);

      // Containment edge: file -> definition
      if (fileId && defId) {
        edgeRows.push([fileId, defId, 'contains', 1.0, 0]);
      }

      if (!def.children?.length) continue;
      if (!defId) continue;

      for (const child of def.children) {
        // Child node
        const qualifiedName = `${def.name}.${child.name}`;
        childRows.push([
          child.name,
          child.kind,
          relPath,
          child.line,
          child.endLine || null,
          defId,
          qualifiedName,
          def.name,
          child.visibility || null,
        ]);
      }
    }
  }

  // Insert children first (so they exist for edge lookup)
  batchInsertNodes(db, childRows);

  // Now re-fetch IDs to include newly-inserted children, then add child edges
  for (const [relPath, symbols] of allSymbols) {
    const nodeIdMap = new Map<string, number>();
    for (const row of bulkNodeIdsByFile(db, relPath)) {
      nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
    }
    for (const def of symbols.definitions) {
      if (!def.children?.length) continue;
      const defId = nodeIdMap.get(`${def.name}|${def.kind}|${def.line}`);
      if (!defId) continue;
      for (const child of def.children) {
        const childId = nodeIdMap.get(`${child.name}|${child.kind}|${child.line}`);
        if (childId) {
          edgeRows.push([defId, childId, 'contains', 1.0, 0]);
          if (child.kind === 'parameter') {
            edgeRows.push([childId, defId, 'parameter_of', 1.0, 0]);
          }
        }
      }
    }
  }

  batchInsertEdges(db, edgeRows);
}

// ── JS fallback: Phase 4 ────────────────────────────────────────────

function updateFileHashes(
  _db: BetterSqlite3Database,
  allSymbols: Map<string, ExtractorOutput>,
  precomputedData: Map<string, PrecomputedFileData>,
  metadataUpdates: MetadataUpdate[],
  rootDir: string,
  upsertHash: SqliteStatement | null,
): void {
  if (!upsertHash) return;

  for (const [relPath] of allSymbols) {
    const precomputed = precomputedData.get(relPath);
    if (precomputed?._reverseDepOnly) {
      // no-op: file unchanged, hash already correct
    } else if (precomputed?.hash) {
      let mtime: number;
      let size: number;
      if (precomputed.stat) {
        mtime = precomputed.stat.mtime;
        size = precomputed.stat.size;
      } else {
        const rawStat = fileStat(path.join(rootDir, relPath));
        mtime = rawStat ? Math.floor(rawStat.mtimeMs) : 0;
        size = rawStat ? rawStat.size : 0;
      }
      upsertHash.run(relPath, precomputed.hash, mtime, size);
    } else {
      const absPath = path.join(rootDir, relPath);
      let code: string | null;
      try {
        code = readFileSafe(absPath);
      } catch {
        code = null;
      }
      if (code !== null) {
        const stat = fileStat(absPath);
        const mtime = stat ? Math.floor(stat.mtimeMs) : 0;
        const size = stat ? stat.size : 0;
        upsertHash.run(relPath, fileHash(code), mtime, size);
      }
    }
  }

  // Also update metadata-only entries (self-heal mtime/size without re-parse)
  for (const item of metadataUpdates) {
    const mtime = item.stat ? Math.floor(item.stat.mtime) : 0;
    const size = item.stat ? item.stat.size : 0;
    upsertHash.run(item.relPath, item.hash, mtime, size);
  }
}

// ── Main entry point ────────────────────────────────────────────────

export async function insertNodes(ctx: PipelineContext): Promise<void> {
  const { db, allSymbols, filesToParse, metadataUpdates, rootDir, removed } = ctx;

  // Populate fileSymbols before any DB writes (used by later stages)
  for (const [relPath, symbols] of allSymbols) {
    ctx.fileSymbols.set(relPath, symbols);
  }

  const t0 = performance.now();

  // Try native Rust path first — single transaction, no JS↔C overhead
  if (ctx.engineName === 'native' && tryNativeInsert(ctx)) {
    ctx.timing.insertMs = performance.now() - t0;

    // Removed-file hash cleanup is handled inside the native call
    return;
  }

  // JS fallback
  const precomputedData = new Map<string, PrecomputedFileData>();
  for (const item of filesToParse) {
    if (item.relPath) precomputedData.set(item.relPath, item as PrecomputedFileData);
  }

  let upsertHash: SqliteStatement | null;
  try {
    upsertHash = db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
  } catch {
    upsertHash = null;
  }

  const insertAll = db.transaction(() => {
    insertDefinitionsAndExports(db, allSymbols);
    insertChildrenAndEdges(db, allSymbols);
    updateFileHashes(db, allSymbols, precomputedData, metadataUpdates, rootDir, upsertHash);
  });

  insertAll();
  ctx.timing.insertMs = performance.now() - t0;

  // Clean up removed file hashes
  if (upsertHash && removed.length > 0) {
    const deleteHash = db.prepare('DELETE FROM file_hashes WHERE file = ?');
    for (const relPath of removed) {
      deleteHash.run(relPath);
    }
  }
}
