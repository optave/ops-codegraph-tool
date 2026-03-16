/**
 * Stage: insertNodes
 *
 * Batch-inserts file nodes, definitions, exports, children, and contains/parameter_of edges.
 * Updates file hashes for incremental builds.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { bulkNodeIdsByFile } from '../../../../db/index.js';
import {
  batchInsertEdges,
  batchInsertNodes,
  fileHash,
  fileStat,
  readFileSafe,
} from '../helpers.js';

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function insertNodes(ctx) {
  const { db, allSymbols, filesToParse, metadataUpdates, rootDir, removed } = ctx;

  // Build lookup from incremental data (pre-computed hashes + stats)
  const precomputedData = new Map();
  for (const item of filesToParse) {
    if (item.relPath) {
      precomputedData.set(item.relPath, item);
    }
  }

  const bulkGetNodeIds = { all: (file) => bulkNodeIdsByFile(db, file) };

  // Prepare hash upsert
  let upsertHash;
  try {
    upsertHash = db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
  } catch {
    upsertHash = null;
  }

  // Populate fileSymbols before the transaction so it is a pure input
  // to (rather than a side-effect of) the DB write — avoids partial
  // population if the transaction rolls back.
  for (const [relPath, symbols] of allSymbols) {
    ctx.fileSymbols.set(relPath, symbols);
  }

  const insertAll = db.transaction(() => {
    // Phase 1: Batch insert all file nodes + definitions + exports
    // Row format: [name, kind, file, line, end_line, parent_id, qualified_name, scope, visibility]
    const phase1Rows = [];
    for (const [relPath, symbols] of allSymbols) {
      phase1Rows.push([relPath, 'file', relPath, 0, null, null, null, null, null]);
      for (const def of symbols.definitions) {
        // Methods already have 'Class.method' as name — use as qualified_name.
        // For methods, scope is the class portion; for top-level defs, scope is null.
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

    // Phase 1b: Mark exported symbols
    const markExported = db.prepare(
      'UPDATE nodes SET exported = 1 WHERE name = ? AND kind = ? AND file = ? AND line = ?',
    );
    for (const [relPath, symbols] of allSymbols) {
      for (const exp of symbols.exports) {
        markExported.run(exp.name, exp.kind, relPath, exp.line);
      }
    }

    // Phase 3: Batch insert children (needs parent IDs from Phase 2)
    const childRows = [];
    for (const [relPath, symbols] of allSymbols) {
      const nodeIdMap = new Map();
      for (const row of bulkGetNodeIds.all(relPath)) {
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

    // Phase 5: Batch insert contains/parameter_of edges
    const edgeRows = [];
    for (const [relPath, symbols] of allSymbols) {
      const nodeIdMap = new Map();
      for (const row of bulkGetNodeIds.all(relPath)) {
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

      // Update file hash — skip reverse-dep files (unchanged)
      if (upsertHash) {
        const precomputed = precomputedData.get(relPath);
        if (precomputed?._reverseDepOnly) {
          // no-op: file unchanged, hash already correct
        } else if (precomputed?.hash) {
          const stat = precomputed.stat || fileStat(path.join(rootDir, relPath));
          const mtime = stat ? Math.floor(stat.mtimeMs) : 0;
          const size = stat ? stat.size : 0;
          upsertHash.run(relPath, precomputed.hash, mtime, size);
        } else {
          const absPath = path.join(rootDir, relPath);
          let code;
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
    }
    batchInsertEdges(db, edgeRows);

    // Also update metadata-only entries (self-heal mtime/size without re-parse)
    if (upsertHash) {
      for (const item of metadataUpdates) {
        const mtime = item.stat ? Math.floor(item.stat.mtimeMs) : 0;
        const size = item.stat ? item.stat.size : 0;
        upsertHash.run(item.relPath, item.hash, mtime, size);
      }
    }
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
