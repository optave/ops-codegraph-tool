/**
 * Stage: insertNodes
 *
 * Batch-inserts file nodes, definitions, exports, children, and contains/parameter_of edges.
 * Updates file hashes for incremental builds.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type BetterSqlite3 from 'better-sqlite3';
import { bulkNodeIdsByFile } from '../../../../db/index.js';
import type { ExtractorOutput, MetadataUpdate, NodeIdRow } from '../../../../types.js';
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

// ── Phase 1: Insert file nodes, definitions, exports ────────────────────

function insertDefinitionsAndExports(
  db: BetterSqlite3.Database,
  allSymbols: Map<string, ExtractorOutput>,
): void {
  const phase1Rows: unknown[][] = [];
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
    }
  }
  batchInsertNodes(db, phase1Rows);

  // Mark exported symbols
  const markExported = db.prepare(
    'UPDATE nodes SET exported = 1 WHERE name = ? AND kind = ? AND file = ? AND line = ?',
  );
  for (const [relPath, symbols] of allSymbols) {
    for (const exp of symbols.exports) {
      markExported.run(exp.name, exp.kind, relPath, exp.line);
    }
  }
}

// ── Phase 2: Insert children (needs parent IDs) ────────────────────────

function insertChildren(
  db: BetterSqlite3.Database,
  allSymbols: Map<string, ExtractorOutput>,
): void {
  const childRows: unknown[][] = [];
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
  batchInsertNodes(db, childRows);
}

// ── Phase 3: Insert containment + parameter_of edges ────────────────────

function insertContainmentEdges(
  db: BetterSqlite3.Database,
  allSymbols: Map<string, ExtractorOutput>,
): void {
  const edgeRows: unknown[][] = [];
  for (const [relPath, symbols] of allSymbols) {
    const nodeIdMap = new Map<string, number>();
    for (const row of bulkNodeIdsByFile(db, relPath)) {
      nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
    }
    const fileId = nodeIdMap.get(`${relPath}|file|0`);
    for (const def of symbols.definitions) {
      const defId = nodeIdMap.get(`${def.name}|${def.kind}|${def.line}`);
      if (fileId && defId) {
        edgeRows.push([fileId, defId, 'contains', 1.0, 0]);
      }
      if (def.children?.length && defId) {
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
  }
  batchInsertEdges(db, edgeRows);
}

// ── Phase 4: Update file hashes ─────────────────────────────────────────

function updateFileHashes(
  _db: BetterSqlite3.Database,
  allSymbols: Map<string, ExtractorOutput>,
  precomputedData: Map<string, PrecomputedFileData>,
  metadataUpdates: MetadataUpdate[],
  rootDir: string,
  upsertHash: BetterSqlite3.Statement | null,
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

// ── Main entry point ────────────────────────────────────────────────────

export async function insertNodes(ctx: PipelineContext): Promise<void> {
  const { db, allSymbols, filesToParse, metadataUpdates, rootDir, removed } = ctx;

  const precomputedData = new Map<string, PrecomputedFileData>();
  for (const item of filesToParse) {
    if (item.relPath) precomputedData.set(item.relPath, item as PrecomputedFileData);
  }

  let upsertHash: BetterSqlite3.Statement | null;
  try {
    upsertHash = db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
  } catch {
    upsertHash = null;
  }

  // Populate fileSymbols before the transaction so it is a pure input
  for (const [relPath, symbols] of allSymbols) {
    ctx.fileSymbols.set(relPath, symbols);
  }

  const insertAll = db.transaction(() => {
    insertDefinitionsAndExports(db, allSymbols);
    insertChildren(db, allSymbols);
    insertContainmentEdges(db, allSymbols);
    updateFileHashes(db, allSymbols, precomputedData, metadataUpdates, rootDir, upsertHash);
  });

  const t0 = performance.now();
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
