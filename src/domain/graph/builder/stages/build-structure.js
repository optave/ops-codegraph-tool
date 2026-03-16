/**
 * Stage: buildStructure + classifyRoles
 *
 * Builds directory structure, containment edges, metrics, and classifies node roles.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { debug } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
import { readFileSafe } from '../helpers.js';

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function buildStructure(ctx) {
  const { db, fileSymbols, rootDir, discoveredDirs, allSymbols, isFullBuild } = ctx;

  // Build line count map (prefer cached _lineCount from parser)
  ctx.lineCountMap = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    if (symbols.lineCount ?? symbols._lineCount) {
      ctx.lineCountMap.set(relPath, symbols.lineCount ?? symbols._lineCount);
    } else {
      const absPath = path.join(rootDir, relPath);
      try {
        const content = readFileSafe(absPath);
        ctx.lineCountMap.set(relPath, content.split('\n').length);
      } catch {
        ctx.lineCountMap.set(relPath, 0);
      }
    }
  }

  // For incremental builds, load unchanged files from DB for complete structure
  if (!isFullBuild) {
    const existingFiles = db.prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'").all();
    const defsByFile = db.prepare(
      "SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file' AND kind != 'directory'",
    );
    const importCountByFile = db.prepare(
      `SELECT COUNT(DISTINCT n2.file) AS cnt FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       WHERE n1.file = ? AND e.kind = 'imports'`,
    );
    const lineCountByFile = db.prepare(
      `SELECT n.name AS file, m.line_count
       FROM node_metrics m JOIN nodes n ON m.node_id = n.id
       WHERE n.kind = 'file'`,
    );
    const cachedLineCounts = new Map();
    for (const row of lineCountByFile.all()) {
      cachedLineCounts.set(row.file, row.line_count);
    }
    let loadedFromDb = 0;
    for (const { file: relPath } of existingFiles) {
      if (!fileSymbols.has(relPath)) {
        const importCount = importCountByFile.get(relPath)?.cnt || 0;
        fileSymbols.set(relPath, {
          definitions: defsByFile.all(relPath),
          imports: new Array(importCount),
          exports: [],
        });
        loadedFromDb++;
      }
      if (!ctx.lineCountMap.has(relPath)) {
        const cached = cachedLineCounts.get(relPath);
        if (cached != null) {
          ctx.lineCountMap.set(relPath, cached);
        } else {
          const absPath = path.join(rootDir, relPath);
          try {
            const content = readFileSafe(absPath);
            ctx.lineCountMap.set(relPath, content.split('\n').length);
          } catch {
            ctx.lineCountMap.set(relPath, 0);
          }
        }
      }
    }
    debug(`Structure: ${fileSymbols.size} files (${loadedFromDb} loaded from DB)`);
  }

  // Build directory structure
  const t0 = performance.now();
  const relDirs = new Set();
  for (const absDir of discoveredDirs) {
    relDirs.add(normalizePath(path.relative(rootDir, absDir)));
  }
  try {
    const { buildStructure: buildStructureFn } = await import('../../../../features/structure.js');
    const changedFilePaths = isFullBuild ? null : [...allSymbols.keys()];
    buildStructureFn(db, fileSymbols, rootDir, ctx.lineCountMap, relDirs, changedFilePaths);
  } catch (err) {
    debug(`Structure analysis failed: ${err.message}`);
  }
  ctx.timing.structureMs = performance.now() - t0;

  // Classify node roles
  const t1 = performance.now();
  try {
    const { classifyNodeRoles } = await import('../../../../features/structure.js');
    const roleSummary = classifyNodeRoles(db);
    debug(
      `Roles: ${Object.entries(roleSummary)
        .map(([r, c]) => `${r}=${c}`)
        .join(', ')}`,
    );
  } catch (err) {
    debug(`Role classification failed: ${err.message}`);
  }
  ctx.timing.rolesMs = performance.now() - t1;
}
